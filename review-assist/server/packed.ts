import { promisify } from "node:util";
import { deflateRaw } from "node:zlib";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import type { z } from "zod";
import type { Deflated } from "../shared/protocol";

const deflate = promisify(deflateRaw);
const MIN_PACKED_CHARS = 16_384;

export function handlePacked<Input extends z.ZodType, Output>(
  server: PluginServerContext,
  contract: PluginRpcContract<Input, z.ZodType<unknown, Output | Deflated>>,
  handler: (input: z.output<Input>, context: PluginHandlerContext) => Output | Promise<Output>,
): void {
  server.handle(contract, async (input, context) => packed(await handler(input, context)));
}

export async function packed<Output>(output: Output): Promise<Output | Deflated> {
  const json = JSON.stringify(output);
  if (json.length < MIN_PACKED_CHARS) return output;
  const deflated = (await deflate(json)).toString("base64");
  return deflated.length < json.length ? { deflated } : output;
}
