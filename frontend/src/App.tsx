import { useCallback, useLayoutEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import type { Layout, LayoutChangedMeta, PanelSize } from "react-resizable-panels";
import { api } from "./lib/api";
import { useHotkeys } from "./hooks/useHotkeys";
import { useNpzNavigation } from "./hooks/useNpzNavigation";
import { useAppStore } from "./store/useAppStore";
import { canEnableOp, useCompareStore } from "./store/useCompareStore";
import { FolderTree } from "./components/FolderTree";
import { NpzInfo } from "./components/NpzInfo";
import { NpzList } from "./components/NpzList";
import { TopBar } from "./components/TopBar";
import { CompareBar } from "./components/compare/CompareBar";
import { ComparePanel } from "./components/compare/ComparePanel";
import { GalleryGrid } from "./components/gallery/GalleryGrid";
import { Lightbox } from "./components/gallery/Lightbox";

const HANDLE_CLASS =
  "relative shrink-0 bg-zinc-800 transition-colors data-[resizing]:bg-cyan-600 hover:bg-cyan-700/60 " +
  "aria-[orientation=vertical]:w-px aria-[orientation=horizontal]:h-px";

function isCollapsedSize(size: PanelSize): boolean {
  return size.inPixels < 2 || size.asPercentage === 0;
}

/**
 * Dragging past minSize goes through the same `panel` store as the toggle.
 * After collapse the sash stays enabled so you can drag it back (VS Code panel).
 * Button-open restores the last split ratio; drag-open keeps the size the sash set.
 */
function applyPanelLayout(
  panel: "hidden" | "split" | "full",
  gallery: { collapse: () => void; expand: () => void; isCollapsed: () => boolean },
  compare: {
    collapse: () => void;
    expand: () => void;
    isCollapsed: () => boolean;
    resize: (size: number | string) => void;
  },
  splitComparePercent: number,
): void {
  if (panel === "hidden") {
    // Expand gallery first so it can reclaim space, then collapse compare.
    // The other order lets gallery.expand() restore the last split ratio and
    // bring compare back on screen while store.panel is already "hidden".
    if (gallery.isCollapsed()) gallery.expand();
    compare.collapse();
    return;
  }
  if (panel === "full") {
    if (!gallery.isCollapsed()) gallery.collapse();
    if (compare.isCollapsed()) compare.expand();
    return;
  }
  if (gallery.isCollapsed()) gallery.expand();
  if (compare.isCollapsed()) {
    compare.expand();
    compare.resize(`${splitComparePercent}%`);
    return;
  }
  // Dragging the sash back from collapsed already sized the pane; don't snap it.
}

export default function App() {
  const queryClient = useQueryClient();
  const currentDir = useAppStore((state) => state.currentDir);
  const lightbox = useAppStore((state) => state.lightbox);
  const nav = useNpzNavigation();

  const panel = useCompareStore((state) => state.panel);
  const setPanel = useCompareStore((state) => state.setPanel);
  const advanceToggle = useCompareStore((state) => state.advanceToggle);
  const setToggleIndex = useCompareStore((state) => state.setToggleIndex);
  const requestFit = useCompareStore((state) => state.requestFit);
  const requestActualSize = useCompareStore((state) => state.requestActualSize);
  const toggleOp = useCompareStore((state) => state.toggleOp);
  const tileCount = useCompareStore((state) => {
    const source = state.mode === "cross" ? state.items.length : state.insideKeys.length;
    return source + (state.opEnabled && canEnableOp(source) ? 1 : 0);
  });

  const mainLayout = useDefaultLayout({ id: "npzview.main", panelIds: ["left", "right"] });
  const leftLayout = useDefaultLayout({ id: "npzview.left", panelIds: ["tree", "list"] });
  const rightLayout = useDefaultLayout({
    id: "npzview.right",
    panelIds: ["gallery", "compare"],
    // Collapse/expand is driven by panel state; only persist sizes the user dragged.
    onlySaveAfterUserInteractions: true,
  });
  const galleryPanelRef = usePanelRef();
  const comparePanelRef = usePanelRef();
  const applyingLayoutRef = useRef(false);

  useLayoutEffect(() => {
    const gallery = galleryPanelRef.current;
    const compare = comparePanelRef.current;
    if (!gallery || !compare) return;
    applyingLayoutRef.current = true;
    applyPanelLayout(
      panel,
      gallery,
      compare,
      useCompareStore.getState().splitComparePercent,
    );
    queueMicrotask(() => {
      applyingLayoutRef.current = false;
    });
  }, [panel, galleryPanelRef, comparePanelRef]);

  const persistRightLayout = useCallback(
    (layout: Layout, meta: LayoutChangedMeta) => {
      // A 0% snapshot is a hidden/full view, not a split ratio worth restoring.
      if ((layout.compare ?? 0) < 1 || (layout.gallery ?? 0) < 1) return;
      rightLayout.onLayoutChanged(layout, meta);
    },
    [rightLayout],
  );

  const onCompareResize = useCallback((next: PanelSize, _id: string | number | undefined, prev: PanelSize | undefined) => {
    if (!prev || applyingLayoutRef.current) return;
    const collapsed = isCollapsedSize(next);
    const { panel: current, setPanel, setSplitComparePercent } = useCompareStore.getState();
    if (collapsed !== isCollapsedSize(prev)) {
      if (collapsed && current === "split") setPanel("hidden");
      else if (!collapsed && current === "hidden") {
        setPanel("split");
        if (next.asPercentage >= 15) setSplitComparePercent(next.asPercentage);
      }
      return;
    }
    if (!collapsed && current === "split") setSplitComparePercent(next.asPercentage);
  }, []);

  const onGalleryResize = useCallback((next: PanelSize, _id: string | number | undefined, prev: PanelSize | undefined) => {
    if (!prev || applyingLayoutRef.current) return;
    if (isCollapsedSize(next) === isCollapsedSize(prev)) return;
    const current = useCompareStore.getState().panel;
    if (isCollapsedSize(next) && current === "split") {
      useCompareStore.getState().setPanel("full");
    } else if (!isCollapsedSize(next) && current === "full") {
      useCompareStore.getState().setPanel("split");
    }
  }, []);

  const refreshCurrentDir = useCallback(() => {
    if (!currentDir) return;
    void api.refresh(currentDir).then(() => {
      void queryClient.invalidateQueries({ queryKey: ["dirs"] });
      void queryClient.invalidateQueries({ queryKey: ["npz-list"] });
    });
  }, [currentDir, queryClient]);

  const playing = useCompareStore((state) => state.sequence.playing);
  const sequenceEngaged = useCompareStore((state) => state.sequence.engaged);

  useHotkeys(
    {
      ArrowLeft: () => {
        if (playing || sequenceEngaged) return;
        void nav.go("file", "prev");
      },
      ArrowRight: () => {
        if (playing || sequenceEngaged) return;
        void nav.go("file", "next");
      },
      ArrowUp: () => {
        if (playing || sequenceEngaged) return;
        void nav.go("folder", "prev");
      },
      ArrowDown: () => {
        if (playing || sequenceEngaged) return;
        void nav.go("folder", "next");
      },
      space: () => advanceToggle(tileCount),
      "1": () => setToggleIndex(0),
      "2": () => tileCount > 1 && setToggleIndex(1),
      "3": () => tileCount > 2 && setToggleIndex(2),
      "4": () => tileCount > 3 && setToggleIndex(3),
      g: () => toggleOp(),
      G: () => toggleOp(),
      f: () => setPanel(panel === "full" ? "split" : "full"),
      F: () => setPanel(panel === "full" ? "split" : "full"),
      "ctrl+0": requestFit,
      "ctrl+1": requestActualSize,
      Escape: () => setPanel("hidden"),
      r: refreshCurrentDir,
      R: refreshCurrentDir,
    },
    // While the lightbox is open it owns the keyboard.
    !lightbox,
  );

  return (
    <div className="flex h-full flex-col">
      <TopBar />

      <Group
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={mainLayout.defaultLayout}
        onLayoutChanged={mainLayout.onLayoutChanged}
      >
        <Panel id="left" defaultSize="22" minSize="14" maxSize="45" className="min-w-0">
          <Group
            orientation="vertical"
            className="h-full"
            defaultLayout={leftLayout.defaultLayout}
            onLayoutChanged={leftLayout.onLayoutChanged}
          >
            <Panel id="tree" defaultSize="42" minSize="15" className="min-h-0">
              <FolderTree />
            </Panel>
            <Separator className={HANDLE_CLASS} />
            <Panel id="list" minSize="20" className="min-h-0">
              <NpzList />
            </Panel>
          </Group>
        </Panel>

        <Separator className={HANDLE_CLASS} />

        <Panel id="right" minSize="30" className="min-w-0">
          <div className="flex h-full flex-col">
            <NpzInfo />
            <CompareBar />

            <Group
              orientation="vertical"
              className="min-h-0 flex-1"
              defaultLayout={rightLayout.defaultLayout}
              onLayoutChanged={persistRightLayout}
              resizeTargetMinimumSize={{ coarse: 28, fine: 12 }}
            >
              <Panel
                id="gallery"
                panelRef={galleryPanelRef}
                minSize="15"
                collapsible
                collapsedSize="0%"
                className="min-h-0"
                onResize={onGalleryResize}
              >
                <GalleryGrid />
              </Panel>
              <Separator
                id="gallery-compare-separator"
                data-testid="gallery-compare-separator"
                className={HANDLE_CLASS}
              />
              <Panel
                id="compare"
                data-testid="compare"
                panelRef={comparePanelRef}
                defaultSize="45"
                minSize="15"
                collapsible
                collapsedSize="0%"
                className="min-h-0"
                onResize={onCompareResize}
              >
                <ComparePanel />
              </Panel>
            </Group>
          </div>
        </Panel>
      </Group>

      <Lightbox />
    </div>
  );
}
