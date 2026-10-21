const HEADER_SEPARATOR = "\r\n\r\n";

export function encodeMessage(message: object): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}${HEADER_SEPARATOR}`, "ascii"), body]);
}

export function decodeMessages(buffer: Buffer): { bodies: string[]; rest: Buffer } {
  const bodies: string[] = [];
  let rest = buffer;
  for (;;) {
    const headerEnd = rest.indexOf(HEADER_SEPARATOR);
    if (headerEnd < 0) {
      return { bodies, rest };
    }
    const header = rest.subarray(0, headerEnd).toString("ascii");
    const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1]);
    const bodyStart = headerEnd + HEADER_SEPARATOR.length;
    if (!Number.isFinite(length)) {
      rest = rest.subarray(bodyStart);
      continue;
    }
    if (rest.byteLength < bodyStart + length) {
      return { bodies, rest };
    }
    bodies.push(rest.subarray(bodyStart, bodyStart + length).toString("utf8"));
    rest = rest.subarray(bodyStart + length);
  }
}
