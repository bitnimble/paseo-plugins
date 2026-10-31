import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { ReviewStates } from "../server/review-state";
import { GuideStore } from "../server/store";
import { type DraftComment, UNCOMMITTED_MODE } from "../shared/protocol";
import { freshRepo, gitIn, removeScratch, scratchDirectory, writeIn } from "./repo";

after(removeScratch);

const target = (directory: string) => ({ directory, mode: UNCOMMITTED_MODE });

function repoWithChanges(): string {
  const dir = freshRepo();
  writeIn(dir, "app.ts", "one\ntwo\nthree\n");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "base");
  writeIn(dir, "app.ts", "one\nTWO\nthree\n");
  writeIn(dir, "notes.md", "new\n");
  return dir;
}

function fakePaseo(answer: string) {
  const calls = { prompts: [] as string[], providers: [] as string[], archived: 0 };
  const agent = {
    id: "agent-1",
    waitForFinish: async () => ({ status: "idle", lastMessage: answer, error: null, final: null }),
    archive: async () => {
      calls.archived++;
      return { archivedAt: new Date().toISOString() };
    },
  };
  const paseo = {
    providers: {
      waitForReady: async () => ({
        entries: [{ provider: "fake", status: "ready", models: [{ id: "model", label: "Model", isDefault: true }] }],
      }),
    },
    workspaces: {
      ref: () => ({
        agents: {
          create: async (options: { prompt: string; config: { provider: string } }) => {
            calls.prompts.push(options.prompt);
            calls.providers.push(options.config.provider);
            return agent;
          },
        },
      }),
    },
  };
  return { paseo: paseo as unknown as PluginHandlerContext["paseo"], calls };
}

async function settled(store: GuideStore, directory: string): ReturnType<GuideStore["read"]> {
  for (let i = 0; i < 500; i++) {
    const state = await store.read(target(directory));
    if (state.job?.status !== "running") return state;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error("generation never settled");
}

const ANSWER = JSON.stringify({
  sections: [
    { title: "Rename", description: "Shouts two.", regions: [{ hunk: "h0", from: 0, to: 3 }], files: [] },
    { title: "Notes", description: "Adds notes.", regions: [{ hunk: "h1", from: 0, to: 0 }], files: [] },
  ],
});

test("a generation runs one agent, stores a private guide and archives the agent", async () => {
  const repo = repoWithChanges();
  const cache = scratchDirectory();
  const { paseo, calls } = fakePaseo(ANSWER);
  const store = new GuideStore(cache, async () => "");

  const job = store.generate({ ...target(repo), workspaceId: "w" }, paseo);
  assert.equal(store.generate({ ...target(repo), workspaceId: "w" }, paseo), job);
  const { job: finished, guide } = await settled(store, repo);

  assert.equal(finished, null);
  assert.deepEqual(
    guide?.sections.map((section) => section.title),
    ["Rename", "Notes"],
  );
  assert.equal(guide?.model, "fake/model");
  assert.deepEqual(calls.providers, ["fake/model"]);
  assert.equal(calls.prompts.length, 1);
  assert.equal(calls.archived, 1);
  const files = readdirSync(cache);
  assert.equal(files.length, 1);
  assert.equal(statSync(join(cache, files[0])).mode & 0o777, 0o600);
});

test("viewed marks and comments persist through concurrent writes and a new guide", async () => {
  const repo = repoWithChanges();
  const cache = scratchDirectory();
  const states = new ReviewStates(cache);
  const slot = target(repo);
  const mark = (path: string, fingerprint: string, viewed = true) =>
    states.apply(slot, { kind: "viewed", marks: [{ path, fingerprint }], viewed });
  const save = (comment: DraftComment) => states.apply(slot, { kind: "comments", remove: [], save: [comment] });
  await Promise.all([mark("app.ts", "1"), mark("app.ts", "2"), mark("notes.md", "1")]);
  await mark("app.ts", "1", false);

  const comment: DraftComment = {
    id: "c1",
    filePath: "app.ts",
    side: "new",
    startLine: 2,
    lineNumber: 2,
    body: "Why shout?",
    context: {
      hunkHeader: "@@ -1,3 +1,3 @@",
      targetLine: { oldLineNumber: null, newLineNumber: 2, type: "add", content: "TWO" },
      lines: [],
    },
    suggestion: null,
    createdAt: "2026-10-21T00:00:00.000Z",
  };
  await Promise.all([save(comment), save({ ...comment, id: "c2" })]);
  await save({ ...comment, body: "Why shout two?" });
  await states.apply(slot, { kind: "comments", remove: ["c2"], save: [] });

  const store = new GuideStore(cache, async () => "fake/model");
  store.generate({ ...slot, workspaceId: "w" }, fakePaseo(ANSWER).paseo);
  await settled(store, repo);

  assert.deepEqual(await new ReviewStates(cache).read(slot), {
    viewed: [
      { path: "app.ts", fingerprint: "2" },
      { path: "notes.md", fingerprint: "1" },
    ],
    comments: [{ ...comment, body: "Why shout two?" }],
  });
  const slotName = createHash("sha256").update(`${repo}\0uncommitted`).digest("hex").slice(0, 32);
  assert.deepEqual(readdirSync(cache).sort(), [`${slotName}.json`, `${slotName}.state.json`]);
});

test("an unusable answer fails the job and keeps the agent for inspection", async () => {
  const repo = repoWithChanges();
  const { paseo, calls } = fakePaseo("I could not do it.");
  const store = new GuideStore(scratchDirectory(), async () => "");
  store.generate({ ...target(repo), workspaceId: "w" }, paseo);
  const { job, guide } = await settled(store, repo);

  assert.equal(job?.status, "failed");
  assert.match(job?.status === "failed" ? job.error : "", /answer was unusable: no JSON object/);
  assert.equal(job?.agentId, "agent-1");
  assert.equal(guide, null);
  assert.equal(calls.archived, 0);
});
