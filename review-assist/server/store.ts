import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { parseDiff } from "../shared/diff";
import { buildGuide } from "../shared/guide";
import { type GuideJob, type GuideRecord, guideRecordSchema } from "../shared/protocol";
import { readDiff } from "./git";
import { messageOf } from "../shared/errors";
import { SegmentError, proposeSections, resolveModel } from "./segment";
import { JsonSlots, type Target, targetKey, targetSlot } from "./slots";

export class GuideStore {
  private readonly jobs = new Map<string, GuideJob>();
  private readonly records: JsonSlots<GuideRecord>;

  constructor(
    directory: string,
    private readonly configuredModel: () => Promise<string>,
  ) {
    this.records = new JsonSlots(directory, guideRecordSchema);
  }

  async read(target: Target): Promise<{ job: GuideJob | null; guide: GuideRecord | null }> {
    return { job: this.job(target), guide: await this.records.read(targetSlot(target)) };
  }

  job(target: Target): GuideJob | null {
    return this.jobs.get(targetKey(target)) ?? null;
  }

  generate(target: Target & { workspaceId: string }, paseo: PluginHandlerContext["paseo"]): GuideJob {
    const key = targetKey(target);
    const current = this.jobs.get(key);
    if (current?.status === "running") {
      return current;
    }
    const job: GuideJob = { status: "running", agentId: null, startedAt: new Date().toISOString() };
    this.jobs.set(key, job);
    void this.run(key, target, paseo).then(
      () => this.jobs.delete(key),
      (error: unknown) =>
        this.jobs.set(key, {
          status: "failed",
          agentId: error instanceof SegmentError ? error.agentId : (this.jobs.get(key)?.agentId ?? null),
          error: messageOf(error),
        }),
    );
    return job;
  }

  private async run(
    key: string,
    target: Target & { workspaceId: string },
    paseo: PluginHandlerContext["paseo"],
  ): Promise<void> {
    const snapshot = await readDiff(target.directory, target.mode);
    if (snapshot.raw === "") {
      throw new Error("There are no changes to review.");
    }
    const diff = parseDiff(snapshot.raw, snapshot.facts);
    const model = await resolveModel(paseo, target.directory, await this.configuredModel());
    const proposal = await proposeSections(paseo, {
      workspaceId: target.workspaceId,
      model,
      diff,
      onAgent: (agentId) => {
        const job = this.jobs.get(key);
        if (job?.status === "running") this.jobs.set(key, { ...job, agentId });
      },
    });
    const record: GuideRecord = {
      diffHash: snapshot.hash,
      raw: snapshot.raw,
      base: snapshot.base,
      root: snapshot.root,
      tree: snapshot.tree,
      facts: snapshot.facts,
      sections: buildGuide(diff, proposal),
      model,
      createdAt: new Date().toISOString(),
    };
    await this.records.update(targetSlot(target), () => record);
  }
}
