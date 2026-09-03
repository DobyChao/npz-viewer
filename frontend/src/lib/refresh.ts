import type { QueryClient } from "@tanstack/react-query";
import { bumpRenderEpoch, versionOf } from "./api";
import { clearNavCache, loadSibling } from "./navCache";
import { useAppStore } from "../store/useAppStore";
import { useCompareStore } from "../store/useCompareStore";

/** Drop frontend caches that would otherwise keep serving a rewritten npz. */
export function invalidateAfterFsRefresh(queryClient: QueryClient): void {
  bumpRenderEpoch();
  clearNavCache();
  void queryClient.invalidateQueries({ queryKey: ["dirs"] });
  void queryClient.invalidateQueries({ queryKey: ["npz-list"] });
  void queryClient.invalidateQueries({ queryKey: ["npz-meta"] });
  void queryClient.invalidateQueries({ queryKey: ["npz-stats"] });
  void queryClient.invalidateQueries({ queryKey: ["npz-data"] });
  void queryClient.invalidateQueries({ queryKey: ["nav-locate"] });
  void queryClient.invalidateQueries({ queryKey: ["nav-at"] });
  void queryClient.invalidateQueries({ queryKey: ["npz-locate"] });

  const path = useAppStore.getState().currentNpz;
  const sequence = useCompareStore.getState().sequence;
  if (!path || !sequence.engaged || sequence.playhead === null) return;
  const head = sequence.playhead;
  void loadSibling(path, head).then((file) => {
    const latest = useCompareStore.getState().sequence;
    if (latest.engaged && latest.playhead === head) {
      useCompareStore.getState().setSequence({
        playPath: file.path,
        playName: file.name,
        playVersion: versionOf(file),
      });
    }
  });
}
