import type { PluginRpcContract } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback } from "react";
import type { z } from "zod";
import { type Deflated, isDeflated } from "../shared/protocol";
import { inflated } from "./inflate";

/** `useRpc` for a contract from `definePackedRpc`, inflating outputs that arrive deflated. */
export function usePackedRpc<Input extends z.ZodType, Output extends z.ZodType>(
  contract: PluginRpcContract<Input, Output>,
): (input: z.input<Input>) => Promise<Exclude<z.output<Output>, Deflated>> {
  const call = useRpc(contract);
  return useCallback(
    async (input) => {
      const output = await call(input);
      const value = isDeflated(output) ? await contract.output.parseAsync(JSON.parse(inflated(output.deflated))) : output;
      return inflatedOnce(contract.name, value);
    },
    [call, contract],
  );
}

function inflatedOnce<Value>(name: string, value: Value): Exclude<Value, Deflated> {
  if (isDeflated(value)) throw new Error(`${name} sent a deflated output inside a deflated output`);
  return value as Exclude<Value, Deflated>;
}
