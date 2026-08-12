import { useCallback, useState } from "react";
import { api, ApiError } from "../lib/api";
import { useAppStore } from "../store/useAppStore";

export type NavScope = "file" | "folder";
export type NavDirection = "next" | "prev";

/**
 * Arrow-key navigation across the result tree.
 *
 * `file` walks the current folder; `folder` jumps to the same ordinal npz in the
 * adjacent sibling folder, which is the cross-version comparison flow.
 */
export function useNpzNavigation() {
  const currentNpz = useAppStore((state) => state.currentNpz);
  const jumpToFile = useAppStore((state) => state.jumpToFile);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const go = useCallback(
    async (scope: NavScope, direction: NavDirection) => {
      if (!currentNpz || busy) return;
      setBusy(true);
      setMessage(null);
      try {
        const result = await api.sibling(currentNpz, scope, direction);
        jumpToFile(result.path, result.index);
      } catch (error) {
        setMessage(error instanceof ApiError ? error.message : "导航失败");
        window.setTimeout(() => setMessage(null), 2500);
      } finally {
        setBusy(false);
      }
    },
    [currentNpz, busy, jumpToFile],
  );

  return { go, busy, message, enabled: Boolean(currentNpz) };
}
