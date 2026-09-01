import { useQuery } from "@tanstack/react-query";
import { api, versionOf } from "../lib/api";
import { useAppStore } from "../store/useAppStore";
import type { NpzMeta } from "../lib/types";

export interface CurrentNpz {
  path: string | null;
  meta: NpzMeta | undefined;
  version: string;
  isLoading: boolean;
  error: unknown;
}

export function useCurrentNpz(): CurrentNpz {
  const path = useAppStore((state) => state.currentNpz);
  const { data, isLoading, error } = useQuery({
    queryKey: ["npz-meta", path],
    queryFn: () => api.meta(path!),
    enabled: Boolean(path),
    staleTime: 0,
  });

  return {
    path,
    meta: data,
    version: data ? versionOf(data) : "",
    isLoading,
    error,
  };
}
