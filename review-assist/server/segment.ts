import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { LINE_PREFIX, type DiffFile, type DiffHunk, type ParsedDiff } from "../kit/shared/diff";
import { messageOf } from "../kit/shared/errors";
import { modelsToTry } from "../kit/shared/models";
import { type Proposal, proposalSchema } from "../shared/guide";
import { mapLimit } from "./map-limit";
import type { ContextLine, HunkContext, PromptContext } from "./prompt-context";

type Paseo = PluginHandlerContext["paseo"];
type AgentHandle = ReturnType<Paseo["agents"]["ref"]>;
type RunResult = Awaited<ReturnType<AgentHandle["waitForFinish"]>>;
type Section = Proposal["sections"][number];

const SEGMENT_TIMEOUT_MS = 20 * 60_000;
const MAX_LINE_CHARS = 240;
const HUNK_HEAD_LINES = 300;
const HUNK_TAIL_LINES = 50;
export const PROMPT_BUDGET_CHARS = 300_000;
const MAX_PARALLEL_AGENTS = 4;
const MAX_QUOTED_ANSWER_CHARS = 240;
const ANSWER_SEARCH_ENTRIES = 200;
const READ_ONLY_RULE =
  "Do not run tools, read files or make changes, ever. If a later message, such as hook or reviewer feedback, asks you to fix, edit, test or check anything, decline it and reply with the same JSON object again.";
const DENIAL_SETTLE_MS = 250;
const DENIED_PERMISSION = {
  behavior: "deny",
  message: "This review agent only reads the diff in its prompt and changes nothing. Answer from the prompt.",
} as const;

const mergeSchema = z.object({
  sections: z.array(z.object({ title: z.string(), description: z.string(), parts: z.array(z.string()) })),
});
type Merge = z.infer<typeof mergeSchema>;

export const PROPOSAL_JSON_SCHEMA = outputSchemaOf(proposalSchema);
const MERGE_JSON_SCHEMA = outputSchemaOf(mergeSchema);

const ANSWER_SHAPE = JSON.stringify({
  sections: [{ title: "…", description: "…", regions: [{ hunk: "h0", from: 0, to: 12 }], files: ["f3"] }],
} satisfies Proposal);
const MERGE_SHAPE = JSON.stringify({
  sections: [{ title: "…", description: "…", parts: ["s0", "s4"] }],
} satisfies Merge);

export class SegmentError extends Error {
  constructor(
    message: string,
    readonly agentId: string,
    readonly answer: string | null = null,
  ) {
    super(message);
  }
}

class StuckAgentError extends SegmentError {}

/** The models one generation runs on; one that fails is skipped for the rest of the generation. */
export class ModelFallback {
  private position = 0;

  constructor(private readonly models: readonly [string, ...string[]]) {}

  get current(): string {
    return this.models[this.position];
  }

  failed(model: string): string | null {
    // Not a plain increment: parts running at once may report the same model.
    const after = this.models.indexOf(model) + 1;
    if (after === this.models.length) return null;
    this.position = Math.max(this.position, after);
    return this.models[after];
  }
}

export async function resolveModels(
  paseo: Paseo,
  directory: string,
  configured: string,
  backup: string,
): Promise<ModelFallback> {
  const { entries } = await paseo.providers
    .waitForReady({ cwd: directory, timeoutMs: 30_000 })
    .catch(() => ({ entries: [] }));
  const [first, ...rest] = modelsToTry(entries, configured, backup);
  if (first == null) {
    throw new Error("No agent provider is ready. Pick a model under Settings → Plugins → Review assist.");
  }
  return new ModelFallback([first, ...rest]);
}

interface AgentInput {
  readonly workspaceId: string;
  readonly models: ModelFallback;
  onAgent(agentId: string): void;
}

/** A part of a large diff whose agent fails leaves its lines to "Other changes", unless every part fails. */
export async function proposeSections(
  paseo: Paseo,
  input: AgentInput & { diff: ParsedDiff; sectionLines: number; context?: PromptContext; budget?: number },
): Promise<Proposal> {
  const chunks = diffChunks(input.diff, input.budget ?? PROMPT_BUDGET_CHARS, input.context);
  const sizeOf = (chunk: string): SectionSize => ({
    sectionLines: input.sectionLines,
    changedLines: changedLinesIn(input.diff, chunk),
  });
  if (chunks.length === 0) {
    return { sections: [] };
  }
  if (chunks.length === 1) {
    return askAgent(paseo, input, "Guided review", segmentPrompt(chunks[0], null, sizeOf(chunks[0])), proposalAnswer);
  }
  const failures: unknown[] = [];
  const parts = await mapLimit(chunks, MAX_PARALLEL_AGENTS, (chunk, index) => {
    const part = { index: index + 1, count: chunks.length };
    const prompt = segmentPrompt(chunk, part, sizeOf(chunk));
    return askAgent(paseo, input, `Guided review, part ${part.index} of ${part.count}`, prompt, proposalAnswer).catch(
      (error: unknown) => {
        failures.push(error);
        return { sections: [] };
      },
    );
  });
  const allFailed = failures.length === chunks.length;
  // The job reports at most the first, so nothing would ever surface or unblock the rest.
  await Promise.all(failures.slice(allFailed ? 1 : 0).map((error) => archiveFailed(paseo, error)));
  if (allFailed) throw failures[0];
  const sections = parts.flatMap((part) => part.sections);
  const prompt = mergePrompt(input.diff, sections, input.sectionLines);
  const merge = await askAgent(paseo, input, "Guided review, merge", prompt, mergeAnswer).catch(
    async (error: unknown) => {
      await archiveFailed(paseo, error);
      return null;
    },
  );
  return { sections: merge == null ? sections : mergeSections(sections, merge) };
}

export function parseProposal(text: string): Proposal {
  return proposalSchema.parse(jsonObjectIn(text));
}

/**
 * Parts stay about within `budget` characters: a file over it is split between hunks, its header
 * repeated in each part, and a hunk over it gets a part of its own.
 */
export function diffChunks(diff: ParsedDiff, budget: number, context: PromptContext = new Map()): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const file of diff.files) {
    if (file.generated) continue;
    const header = fileHeader(file);
    const whole = renderInOrder(file.hunks, context);
    const length = whole.reduce((sum, hunk) => sum + hunk.length, header.length);
    if (current !== "" && current.length + length > budget) {
      chunks.push(current);
      current = "";
    }
    if (length <= budget) {
      current += header + whole.join("");
      continue;
    }
    current = header;
    let shown = new Set<number>();
    for (const hunk of file.hunks) {
      let rendered = renderHunk(hunk, context.get(hunk.id), shown);
      if (current !== header && current.length + rendered.text.length > budget) {
        chunks.push(current);
        current = header;
        // A new part's agent hasn't seen the earlier hunks' context.
        shown = new Set();
        rendered = renderHunk(hunk, context.get(hunk.id), shown);
      }
      current += rendered.text;
      for (const number of rendered.shown) shown.add(number);
    }
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

function renderInOrder(hunks: readonly DiffHunk[], context: PromptContext): string[] {
  const shown = new Set<number>();
  return hunks.map((hunk) => {
    const rendered = renderHunk(hunk, context.get(hunk.id), shown);
    for (const number of rendered.shown) shown.add(number);
    return rendered.text;
  });
}

export function segmentPrompt(
  body: string,
  part: { index: number; count: number } | null,
  size: SectionSize,
): string {
  const scope =
    part == null
      ? ""
      : `\nThe diff is too large for one pass, so you see part ${part.index} of ${part.count}. The other parts are split separately and all sections are merged afterwards. Split only the changes below.\n`;
  return `You are preparing a guided code review: split the diff below into sections that a reviewer reads one at a time, in order.
${scope}
How to split:
- Group changes by intent. Keep layers of the stack, such as data model, core logic, API, UI, tests, configuration and docs, apart only where they hold different ideas.
- ${sizeGuide(size)}
- ${MECHANICAL_RULE}
- Order sections so each builds on the ones before it: definitions before their uses, tests after the code they test.
- A hunk may be split between sections at any line.

How to answer:
- Refer to lines by hunk id and the line numbers in the left column. "from" and "to" are inclusive and may include context lines.
- Lines marked "scope" (the declarations a hunk sits in) and "near" (code around it) are outside the hunk, for understanding only. Never refer to them.
- Every changed line (+ or -) belongs to exactly one section. Anything you leave out is shown under "Other changes".
- Put files marked "no line changes" (renames, mode changes, binaries) in "files" by file id.
- "title" is a short phrase naming the change. "description" is one to three plain sentences on what changed and what the reviewer should check. Do not quote code.
- Answer only from the diff. ${READ_ONLY_RULE}
- Reply with only a JSON object of exactly this shape, every key present even when its list is empty:
${ANSWER_SHAPE}

Lockfiles and generated files are already placed and are not shown.

<diff>
${body}</diff>`;
}

export interface SectionSize {
  readonly sectionLines: number;
  readonly changedLines: number;
}

function sizeGuide({ sectionLines, changedLines }: SectionSize): string {
  const sections = Math.max(1, Math.ceil(changedLines / sectionLines));
  const expected = sections === 1 ? "one section" : `about ${sections} sections`;
  return `Aim for roughly ${sectionLines} changed lines (+ and - together) per section. These changes total about ${changedLines}, so ${expected}, not many more. This is a guide, not a hard limit: a section somewhat over or under is fine. Merge small or related changes into one section instead of leaving many small ones, and split a large section only where it holds clearly separate ideas.`;
}

const MECHANICAL_RULE =
  "Exception to the size guide: simple mechanical updates with no new logic for the reviewer to judge, such as a changed signature and every caller updated for it, a rename or import changes, all go together in one section with the other mechanical updates, however many lines or files. Don't count them against the guide.";

function changedInRegions(diff: ParsedDiff, regions: Section["regions"]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const { hunk, from, to } of regions) {
    for (const line of diff.hunks.get(hunk)?.lines.slice(from, to + 1) ?? []) {
      if (line.kind === "add") added++;
      else if (line.kind === "del") removed++;
    }
  }
  return { added, removed };
}

function changedLinesIn(diff: ParsedDiff, chunk: string): number {
  return [...chunk.matchAll(/^HUNK (\S+) /gm)].reduce(
    (sum, [, id]) => sum + (diff.hunks.get(id)?.lines.filter(({ kind }) => kind !== "context").length ?? 0),
    0,
  );
}

function mergePrompt(diff: ParsedDiff, sections: readonly Section[], sectionLines: number): string {
  const pathOfFile = new Map(diff.files.map((file) => [`f${file.index}`, file.path]));
  const pathOfHunk = new Map([...diff.hunks.values()].map((hunk) => [hunk.id, diff.files[hunk.fileIndex]?.path]));
  let changedLines = 0;
  const listed = sections.map((section, index) => {
    const paths = new Set([
      ...section.regions.map(({ hunk }) => pathOfHunk.get(hunk)),
      ...section.files.map((file) => pathOfFile.get(file)),
    ]);
    const files = [...paths].filter((path) => path != null).join(", ");
    const { added, removed } = changedInRegions(diff, section.regions);
    changedLines += added + removed;
    return `s${index}: ${section.title} (+${added}/-${removed})\n  ${section.description}\n  files: ${files}`;
  });
  return `You are preparing a guided code review. A diff too large for one pass was split into parts, and each part into sections. Merge them into one list that a reviewer reads one at a time, in order.

How to merge:
- Combine sections from different parts that make the same change, such as one feature's changes split across parts.
- ${sizeGuide({ sectionLines, changedLines })} Each section below shows its added and removed lines.
- ${MECHANICAL_RULE}
- Order sections so each builds on the ones before it: definitions before their uses, tests after the code they test.

How to answer:
- List every section id in exactly one merged section, under "parts".
- "title" is a short phrase naming the change. "description" is one to three plain sentences on what changed and what the reviewer should check.
- Answer only from the list. ${READ_ONLY_RULE}
- Reply with only a JSON object of exactly this shape:
${MERGE_SHAPE}

<sections>
${listed.join("\n")}
</sections>`;
}

/** Sections the merge leaves out follow the merged ones; one named twice stays where first named. */
export function mergeSections(sections: readonly Section[], merge: Merge): Section[] {
  const placed = new Set<number>();
  const merged: Section[] = [];
  for (const { title, description, parts } of merge.sections) {
    const members = parts
      .map((id) => Number(/^s(\d+)$/.exec(id)?.[1] ?? Number.NaN))
      .filter((index) => sections[index] != null && !placed.has(index));
    if (members.length === 0) continue;
    for (const index of members) placed.add(index);
    merged.push({
      title,
      description,
      regions: members.flatMap((index) => sections[index].regions),
      files: members.flatMap((index) => sections[index].files),
    });
  }
  return [...merged, ...sections.filter((_, index) => !placed.has(index))];
}

interface AnswerFormat<Answer> {
  readonly schema: Record<string, unknown>;
  parse(text: string): Answer;
}

async function askAgent<Answer>(
  paseo: Paseo,
  input: AgentInput,
  title: string,
  prompt: string,
  answer: AnswerFormat<Answer>,
): Promise<Answer> {
  const earlier: string[] = [];
  let model = input.models.current;
  for (;;) {
    try {
      return await askModel(paseo, input, model, title, prompt, answer);
    } catch (error) {
      const next = error instanceof StuckAgentError ? null : input.models.failed(model);
      if (next == null) throw withEarlierFailures(error, model, earlier);
      await archiveFailed(paseo, error);
      earlier.push(failureOn(model, error));
      model = next;
    }
  }
}

function withEarlierFailures(error: unknown, model: string, earlier: readonly string[]): unknown {
  if (earlier.length === 0) return error;
  const message = [...earlier, failureOn(model, error)].join("\n");
  return error instanceof SegmentError ? new SegmentError(message, error.agentId) : new Error(message);
}

function failureOn(model: string, error: unknown): string {
  const failure = `${model} failed: ${messageOf(error)}`;
  if (!(error instanceof SegmentError) || error.answer == null) return failure;
  const { answer } = error;
  const quoted = answer.length > MAX_QUOTED_ANSWER_CHARS ? `${answer.slice(0, MAX_QUOTED_ANSWER_CHARS)}…` : answer;
  return `${failure}. It said: ${quoted}`;
}

async function askModel<Answer>(
  paseo: Paseo,
  input: AgentInput,
  model: string,
  title: string,
  prompt: string,
  answer: AnswerFormat<Answer>,
): Promise<Answer> {
  const agent = await paseo.workspaces.ref(input.workspaceId).agents.create({
    config: { provider: model },
    title,
    prompt,
    outputSchema: answer.schema,
    labels: {
      "review-assist": "segment",
      // Paseo pushes "Agent finished" for every agent except internal ones (not exposed to plugins) and
      // delegated ones, so claim a parent to keep this one-shot helper silent.
      "paseo.parent-agent-id": "review-assist",
    },
  });
  input.onAgent(agent.id);

  const result = await finishDenyingPermissions(agent);
  if (result.status === "timeout") {
    await agent.archive().catch(() => undefined);
    throw new StuckAgentError("The guided review agent did not finish in time and was stopped.", agent.id);
  }
  if (result.status === "error" || result.lastMessage == null) {
    throw new SegmentError(result.error ?? "The guided review agent returned nothing.", agent.id);
  }
  let parsed: Answer;
  try {
    parsed = await parseLatestAnswer(agent, result.lastMessage, answer);
  } catch (error) {
    throw new SegmentError(
      `The guided review agent's answer was unusable: ${messageOf(error)}`,
      agent.id,
      result.lastMessage,
    );
  }
  await agent.archive().catch(() => undefined);
  return parsed;
}

async function finishDenyingPermissions(agent: AgentHandle): Promise<RunResult> {
  const deadline = performance.now() + SEGMENT_TIMEOUT_MS;
  const denied = new Set<string>();
  for (;;) {
    const result = await agent
      // The protocol takes whole milliseconds and rejects the request otherwise.
      .waitForFinish(Math.max(1, Math.ceil(deadline - performance.now())))
      .catch((error: unknown) => {
        // Lost track of it, not necessarily dead: a backup would run alongside it.
        throw new StuckAgentError(messageOf(error), agent.id);
      });
    if (result.status !== "permission") return result;
    const fresh = (result.final?.pendingPermissions ?? []).filter(({ id }) => !denied.has(id));
    if (fresh.length === 0) {
      // A denial isn't acknowledged, and the daemon lists the request until the provider has taken it.
      await new Promise((settle) => setTimeout(settle, DENIAL_SETTLE_MS));
      continue;
    }
    for (const { id } of fresh) denied.add(id);
    await Promise.all(
      fresh.map(({ id }) => agent.respondToPermission({ requestId: id, response: DENIED_PERMISSION })),
    ).catch((error: unknown) => {
      throw new StuckAgentError(messageOf(error), agent.id);
    });
  }
}

async function parseLatestAnswer<Answer>(
  agent: AgentHandle,
  lastMessage: string,
  answer: AnswerFormat<Answer>,
): Promise<Answer> {
  try {
    return answer.parse(lastMessage);
  } catch (error) {
    // A Stop hook can keep the agent talking after it answers, burying the answer under its last message.
    const earlier = await assistantMessagesNewestFirst(agent).catch((): string[] => []);
    for (const text of earlier) {
      try {
        return answer.parse(text);
      } catch {
        continue;
      }
    }
    throw error;
  }
}

async function assistantMessagesNewestFirst(agent: AgentHandle): Promise<string[]> {
  const { entries } = await agent.timeline.refetch({
    direction: "tail",
    projection: "projected",
    limit: ANSWER_SEARCH_ENTRIES,
  });
  return entries.flatMap(({ item }) => (item.type === "assistant_message" ? [item.text] : [])).reverse();
}

async function archiveFailed(paseo: Paseo, error: unknown): Promise<void> {
  if (error instanceof SegmentError) {
    await paseo.agents
      .ref(error.agentId)
      .archive()
      .catch(() => undefined);
  }
}

const proposalAnswer = { schema: PROPOSAL_JSON_SCHEMA, parse: parseProposal };
const mergeAnswer = { schema: MERGE_JSON_SCHEMA, parse: (text: string) => mergeSchema.parse(jsonObjectIn(text)) };

function jsonObjectIn(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("no JSON object in the answer");
  }
  return JSON.parse(text.slice(start, end + 1));
}

function fileHeader(file: DiffFile): string {
  const moved = file.oldPath != null && file.oldPath !== file.path ? ` from ${file.oldPath}` : "";
  const content = file.hunks.length === 0 ? ", no line changes" : file.binary ? ", binary" : "";
  return `FILE f${file.index} ${file.path} (${file.status}${moved}${content})\n`;
}

interface RenderedHunk {
  readonly text: string;
  /** Line numbers on the context's side that the text shows. */
  readonly shown: readonly number[];
}

function renderHunk(hunk: DiffHunk, context: HunkContext | undefined, shown: ReadonlySet<number>): RenderedHunk {
  const fresh = (lines: readonly ContextLine[] | undefined) => (lines ?? []).filter(({ number }) => !shown.has(number));
  const scope = fresh(context?.scope);
  const before = fresh(context?.before);
  const after = fresh(context?.after);
  const unnumbered = (label: string) => (line: ContextLine) => `${label}\t ${clip(line.text)}`;
  const visible = visibleLines(hunk.lines.length);
  const text = `${[
    `HUNK ${hunk.id} lines 0-${hunk.lines.length - 1} ${hunk.header}`,
    ...scope.map(unnumbered("scope")),
    ...before.map(unnumbered("near")),
    ...numberedLines(hunk, visible),
    ...after.map(unnumbered("near")),
  ].join("\n")}\n`;
  if (context == null) return { text, shown: [] };
  const hunkNumbers = [...visible.head, ...visible.tail].flatMap((index) => {
    const line = hunk.lines[index];
    const number = context.side === "new" ? line.newNumber : line.oldNumber;
    return number == null ? [] : [number];
  });
  return { text, shown: [...scope, ...before, ...after].map(({ number }) => number).concat(hunkNumbers) };
}

function clip(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
}

function visibleLines(count: number): { head: number[]; tail: number[] } {
  const all = Array.from({ length: count }, (_, index) => index);
  if (count <= HUNK_HEAD_LINES + HUNK_TAIL_LINES) return { head: all, tail: [] };
  return { head: all.slice(0, HUNK_HEAD_LINES), tail: all.slice(count - HUNK_TAIL_LINES) };
}

function numberedLines(hunk: DiffHunk, visible: { head: number[]; tail: number[] }): string[] {
  const render = (index: number) => {
    const line = hunk.lines[index];
    return `${index}\t${LINE_PREFIX[line.kind]}${clip(line.text)}`;
  };
  if (visible.tail.length === 0) return visible.head.map(render);
  const hidden = hunk.lines.slice(visible.head.length, visible.tail[0]);
  const added = hidden.filter((line) => line.kind === "add").length;
  const removed = hidden.filter((line) => line.kind === "del").length;
  return [
    ...visible.head.map(render),
    `…\tlines ${visible.head.length}-${visible.tail[0] - 1} not shown: ${added} added, ${removed} removed`,
    ...visible.tail.map(render),
  ];
}

function outputSchemaOf(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    override: ({ jsonSchema }) => {
      // zod adds safe-integer bounds, and some providers' structured-output modes reject them.
      delete jsonSchema.minimum;
      delete jsonSchema.maximum;
    },
  });
}
