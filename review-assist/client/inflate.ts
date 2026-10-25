import { inflateSync, strFromU8 } from "fflate";

declare function atob(data: string): string;

/** The text a server's `packed` deflated into `base64`. */
export function inflated(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return strFromU8(inflateSync(bytes));
}
