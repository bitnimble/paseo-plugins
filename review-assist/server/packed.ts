import { promisify } from "node:util";
import { deflateRaw } from "node:zlib";
import type { Deflated } from "../shared/protocol";

const deflate = promisify(deflateRaw);
const MIN_PACKED_CHARS = 16_384;

export async function packed<Output>(output: Output): Promise<Output | Deflated> {
  const json = JSON.stringify(output);
  if (json.length < MIN_PACKED_CHARS) return output;
  const deflated = (await deflate(json)).toString("base64");
  return deflated.length < json.length ? { deflated } : output;
}
