import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { LINE_PREFIX, type DiffFile, type DiffHunk, type ParsedDiff } from "../shared/diff";
import { type Proposal, proposalSchema } from "../shared/guide";
import { messageOf } from "../shared/errors";
import { automaticChoice, modelChoices } from "../shared/models";

type Paseo = PluginHandlerContext["paseo"];
type Section = Proposal["sections"][number];

const SEGMENT_TIMEOUT_MS = 20 * 60_000;
const MAX_LINE_CHARS = 240;
const HUNK_HEAD_LINES = 300;
const HUNK_TAIL_LINES = 50;
export const PROMPT_BUDGET_CHARS = 300_000;
const MAX_PARALLEL_AGENTS = 4;

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
  ) {
    super(message);
  }
}

export async function resolveModel(paseo: Paseo, directory: string, configured: string): Promise<string> {
  if (configured.trim() !== "") {
    return configured.trim();
  }
  const { entries } = await paseo.providers.waitForReady({ cwd: directory, timeoutMs: 30_000 });
  const choice = automaticChoice(modelChoices(entries));
  if (choice == null) {
    throw new Error("No agent provider is ready. Pick a model under Settings → Plugins → Review assist.");
  }
  return choice.value;
}

interface AgentInput {
  readonly workspaceId: string;
  readonly model: string;
  onAgent(agentId: string): void;
}

/** A part of a large diff whose agent fails leaves its lines to "Other changes", unless every part fails. */
export async function proposeSections(
  paseo: Paseo,
  input: AgentInput & { diff: ParsedDiff; budget?: number },
): Promise<Proposal> {
  const chunks = diffChunks(input.diff, input.budget ?? PROMPT_BUDGET_CHARS);
  if (chunks.length === 0) {
    return { sections: [] };
  }
  if (chunks.length === 1) {
    return askAgent(paseo, input, "Guided review", segmentPrompt(chunks[0], null), proposalAnswer);
  }
  const failures: unknown[] = [];
  const parts = await mapLimit(chunks, MAX_PARALLEL_AGENTS, (chunk, index) => {
    const part = { index: index + 1, count: chunks.length };
    const prompt = segmentPrompt(chunk, part);
    return askAgent(paseo, input, `Guided review, part ${part.index} of ${part.count}`, prompt, proposalAnswer).catch(
      (error: unknown) => {
        failures.push(error);
        return { sections: [] };
      },
    );
  });
  if (failures.length === chunks.length) {
    throw failures[0];
  }
  // The job reports none of these, so nothing would ever surface or unblock them.
  await Promise.all(failures.map((error) => archiveFailed(paseo, error)));
  const sections = parts.flatMap((part) => part.sections);
  const merge = await askAgent(paseo, input, "Guided review, merge", mergePrompt(input.diff, sections), mergeAnswer).catch(
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

/** Parts stay within `budget` characters, except a file over it on its own: no file is split. */
export function diffChunks(diff: ParsedDiff, budget: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const file of diff.files) {
    if (file.generated) continue;
    const text = renderFile(file);
    if (current !== "" && current.length + text.length > budget) {
      chunks.push(current);
      current = "";
    }
    current += text;
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

export function segmentPrompt(body: string, part: { index: number; count: number } | null): string {
  const scope =
    part == null
      ? ""
      : `\nThe diff is too large for one pass, so you see part ${part.index} of ${part.count}. The other parts are split separately and all sections are merged afterwards. Split only the changes below.\n`;
  return `You are preparing a guided code review: split the diff below into sections that a reviewer reads one at a time, in order.
${scope}
How to split:
- Group changes by intent and by layer of the stack, such as data model, core logic, API, UI, tests, configuration and docs. A section should take a few minutes to review: split large changes and merge trivial ones.
- Order sections so each builds on the ones before it: definitions before their uses, tests after the code they test.
- A hunk may be split between sections at any line.

How to answer:
- Refer to lines by hunk id and the line numbers in the left column. "from" and "to" are inclusive and may include context lines.
- Every changed line (+ or -) belongs to exactly one section. Anything you leave out is shown under "Other changes".
- Put files marked "no line changes" (renames, mode changes, binaries) in "files" by file id.
- "title" is a short phrase naming the change. "description" is one to three plain sentences on what changed and what the reviewer should check. Do not quote code.
- Answer only from the diff. Do not run tools, read files or make changes.
- Reply with only a JSON object of exactly this shape, every key present even when its list is empty:
${ANSWER_SHAPE}

Lockfiles and generated files are already placed and are not shown.

<diff>
${body}</diff>`;
}

function mergePrompt(diff: ParsedDiff, sections: readonly Section[]): string {
  const pathOfFile = new Map(diff.files.map((file) => [`f${file.index}`, file.path]));
  const pathOfHunk = new Map([...diff.hunks.values()].map((hunk) => [hunk.id, diff.files[hunk.fileIndex]?.path]));
  const listed = sections.map((section, index) => {
    const paths = new Set([
      ...section.regions.map(({ hunk }) => pathOfHunk.get(hunk)),
      ...section.files.map((file) => pathOfFile.get(file)),
    ]);
    const files = [...paths].filter((path) => path != null).join(", ");
    return `s${index}: ${section.title}\n  ${section.description}\n  files: ${files}`;
  });
  return `You are preparing a guided code review. A diff too large for one pass was split into parts, and each part into sections. Merge them into one list that a reviewer reads one at a time, in order.

How to merge:
- Combine sections from different parts that make the same change, such as one feature's changes split across parts. Leave sections apart when each is already a few minutes' review.
- Order sections so each builds on the ones before it: definitions before their uses, tests after the code they test.

How to answer:
- List every section id in exactly one merged section, under "parts".
- "title" is a short phrase naming the change. "description" is one to three plain sentences on what changed and what the reviewer should check.
- Answer only from the list. Do not run tools, read files or make changes.
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

async function askAgent<Answer>(
  paseo: Paseo,
  input: AgentInput,
  title: string,
  prompt: string,
  answer: { schema: Record<string, unknown>; parse(text: string): Answer },
): Promise<Answer> {
  const agent = await paseo.workspaces.ref(input.workspaceId).agents.create({
    config: { provider: input.model },
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

  const result = await agent.waitForFinish(SEGMENT_TIMEOUT_MS);
  if (result.status === "permission") {
    throw new SegmentError("The guided review agent is waiting on a permission request.", agent.id);
  }
  if (result.status === "timeout") {
    await agent.archive().catch(() => undefined);
    throw new SegmentError("The guided review agent did not finish in time and was stopped.", agent.id);
  }
  if (result.status === "error" || result.lastMessage == null) {
    throw new SegmentError(result.error ?? "The guided review agent returned nothing.", agent.id);
  }
  let parsed: Answer;
  try {
    parsed = answer.parse(result.lastMessage);
  } catch (error) {
    throw new SegmentError(`The guided review agent's answer was unusable: ${messageOf(error)}`, agent.id);
  }
  await agent.archive().catch(() => undefined);
  return parsed;
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

function renderFile(file: DiffFile): string {
  const moved = file.oldPath != null && file.oldPath !== file.path ? ` from ${file.oldPath}` : "";
  const content = file.hunks.length === 0 ? ", no line changes" : file.binary ? ", binary" : "";
  const lines = [`FILE f${file.index} ${file.path} (${file.status}${moved}${content})`];
  for (const hunk of file.hunks) {
    lines.push(`HUNK ${hunk.id} lines 0-${hunk.lines.length - 1} ${hunk.header}`, ...numberedLines(hunk));
  }
  return `${lines.join("\n")}\n`;
}

function numberedLines(hunk: DiffHunk): string[] {
  const render = (index: number) => {
    const line = hunk.lines[index];
    const text = line.text.length > MAX_LINE_CHARS ? `${line.text.slice(0, MAX_LINE_CHARS)}…` : line.text;
    return `${index}\t${LINE_PREFIX[line.kind]}${text}`;
  };
  const count = hunk.lines.length;
  if (count <= HUNK_HEAD_LINES + HUNK_TAIL_LINES) {
    return hunk.lines.map((_, i) => render(i));
  }
  const hidden = hunk.lines.slice(HUNK_HEAD_LINES, count - HUNK_TAIL_LINES);
  const added = hidden.filter((line) => line.kind === "add").length;
  const removed = hidden.filter((line) => line.kind === "del").length;
  return [
    ...hunk.lines.slice(0, HUNK_HEAD_LINES).map((_, i) => render(i)),
    `…\tlines ${HUNK_HEAD_LINES}-${count - HUNK_TAIL_LINES - 1} not shown: ${added} added, ${removed} removed`,
    ...Array.from({ length: HUNK_TAIL_LINES }, (_, i) => render(count - HUNK_TAIL_LINES + i)),
  ];
}

async function mapLimit<Item, Result>(
  items: readonly Item[],
  limit: number,
  run: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
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
