export interface Failed {
  status: "failed";
  error: string;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function failed(error: unknown): Failed {
  return { status: "failed", error: messageOf(error) };
}

/** The stack, or message, followed by those of every error an `AggregateError` gathers. */
export function detailsOf(error: unknown): string {
  const own = error instanceof Error ? describe(error) : String(error);
  if (!(error instanceof AggregateError)) return own;
  const causes = error.errors.map(
    (cause: unknown, i: number) => `Caused by (${i + 1} of ${error.errors.length}): ${detailsOf(cause)}`,
  );
  return [own, ...causes].join("\n\n");
}

function describe(error: Error): string {
  const heading = `${error.name}: ${error.message}`;
  const { stack } = error;
  if (stack == null) return heading;
  // V8 starts a stack with its heading; other engines list frames only.
  return stack.startsWith(heading) ? stack : `${heading}\n${stack}`;
}
