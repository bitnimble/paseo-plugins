import { usePaseo } from "@getpaseo/plugin/client";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";

type ProvidersSnapshot = Awaited<ReturnType<ReturnType<typeof usePaseo>["providers"]["waitForReady"]>>;

export function useProviders(enabled = true): UseQueryResult<ProvidersSnapshot> {
  const paseo = usePaseo();
  return useQuery({
    queryKey: ["review-providers"],
    queryFn: () => paseo.providers.waitForReady({ timeoutMs: 30_000 }),
    enabled,
  });
}
