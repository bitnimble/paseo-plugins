import { execFile } from "node:child_process";
import { join, sep } from "node:path";
import { z } from "zod";
import { messageOf } from "../shared/errors";
import type { UpdateStatus } from "../shared/protocol";

const PLUGIN_ID = "review-assist";
// Under the daemon's ~60s RPC timeout, so a slow check reports why rather than timing the call out.
const CHECK_TIMEOUT_MS = 45_000;
const INSTALL_TIMEOUT_MS = 30 * 60_000;
const NO_ID = "unknown";

const previewsSchema = z.array(
  z.object({
    outcome: z.string(),
    current: z.object({ currentRevision: z.string().optional() }).optional(),
    target: z.object({ commit: z.string().optional(), version: z.string().optional() }).optional(),
    links: z.array(z.string()).default([]),
    error: z.string().optional(),
  }),
);
const resultsSchema = z.array(z.object({ outcome: z.string(), error: z.string().optional() }));
const cliErrorSchema = z.object({ error: z.object({ message: z.string() }) });

export class PluginUpdates {
  private installing = false;
  private failure: string | null = null;

  async status(): Promise<UpdateStatus> {
    if (this.installing) return { status: "updating" };
    try {
      const status = statusOf(await paseo(["plugin", "update", PLUGIN_ID, "--check", "--json"], CHECK_TIMEOUT_MS));
      return status.status === "available" ? { ...status, failure: this.failure } : status;
    } catch (error) {
      return { status: "unavailable", reason: messageOf(error) };
    }
  }

  /** Returns at once: a build outlasts an RPC, and a successful one replaces this process. */
  install(): void {
    if (this.installing) return;
    this.installing = true;
    this.failure = null;
    paseo(["plugin", "update", PLUGIN_ID, "--yes", "--json"], INSTALL_TIMEOUT_MS)
      .then(resultOf)
      .catch((error: unknown) => messageOf(error))
      .then((failure) => {
        this.failure = failure;
        this.installing = false;
      });
  }
}

export function statusOf(output: string): UpdateStatus {
  const preview = previewsSchema.parse(JSON.parse(output))[0];
  if (preview == null) return { status: "unavailable", reason: "Paseo has no record of this plugin." };
  const current = revisionLabel(preview.current?.currentRevision);
  switch (preview.outcome) {
    case "update":
      return {
        status: "available",
        current,
        target: revisionLabel(preview.target?.commit ?? preview.target?.version),
        review: preview.links[0] ?? null,
        failure: null,
      };
    case "current":
    case "installed-newer":
      return { status: "current", revision: current };
    case "local":
      return { status: "unavailable", reason: "Installed from a local folder, which has no source to update from." };
    default:
      return { status: "unavailable", reason: preview.error ?? "Paseo couldn't check for an update." };
  }
}

/** Why the update failed, or null when it installed. */
export function resultOf(output: string): string | null {
  const result = resultsSchema.parse(JSON.parse(output))[0];
  if (result == null) return "Paseo had nothing to update.";
  return result.outcome === "updated" ? null : (result.error ?? "The update failed.");
}

function revisionLabel(revision: string | undefined): string {
  if (revision == null) return NO_ID;
  return /^[0-9a-f]{40}$/.test(revision) ? revision.slice(0, 7) : revision;
}

function paseo(args: readonly string[], timeout: number): Promise<string> {
  const [command, prefix] = paseoCommand();
  const home = process.env.PASEO_HOME;
  return new Promise((done, fail) => {
    execFile(
      command,
      [...prefix, ...args, ...(home == null ? [] : ["--home", home])],
      { timeout, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        // An error outcome exits non-zero with its reason in the JSON on stdout.
        if (error == null || json(stdout) !== undefined) {
          done(stdout);
          return;
        }
        const reported = cliErrorSchema.safeParse(json(stderr));
        fail(new Error(reported.success ? reported.data.error.message : stderr.trim() || error.message));
      },
    );
  });
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The CLI that came with this daemon, so it speaks the daemon's version; `paseo` on the path otherwise. */
function paseoCommand(): [string, string[]] {
  // The desktop app's daemon points this at its bundled CLI.
  const bundled = process.env.PASEO_CLI;
  if (bundled != null && bundled !== "") return [bundled, []];
  const script = process.argv[1] ?? "";
  const cli = `${sep}@getpaseo${sep}cli${sep}`;
  const at = script.lastIndexOf(cli);
  if (at < 0) return ["paseo", []];
  return [process.execPath, ["--disable-warning=DEP0040", join(script.slice(0, at + cli.length), "bin", "paseo")]];
}
