import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { api } from "./lib/api";
import { useHotkeys } from "./hooks/useHotkeys";
import { useNpzNavigation } from "./hooks/useNpzNavigation";
import { useAppStore } from "./store/useAppStore";
import { useCompareStore } from "./store/useCompareStore";
import { FolderTree } from "./components/FolderTree";
import { NpzInfo } from "./components/NpzInfo";
import { NpzList } from "./components/NpzList";
import { TopBar } from "./components/TopBar";
import { CompareBar } from "./components/compare/CompareBar";
import { ComparePanel } from "./components/compare/ComparePanel";
import { GalleryGrid } from "./components/gallery/GalleryGrid";
import { Lightbox } from "./components/gallery/Lightbox";

const HANDLE_CLASS =
  "relative bg-zinc-800 transition-colors data-[resizing]:bg-cyan-600 hover:bg-cyan-700/60 " +
  "data-[orientation=horizontal]:w-px data-[orientation=vertical]:h-px";

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
  const tileCount = useCompareStore((state) =>
    state.mode === "cross" ? state.items.length : state.insideKeys.length,
  );

  const mainLayout = useDefaultLayout({ id: "npzview.main", panelIds: ["left", "right"] });
  const leftLayout = useDefaultLayout({ id: "npzview.left", panelIds: ["tree", "list"] });
  const rightLayout = useDefaultLayout({ id: "npzview.right", panelIds: ["gallery", "compare"] });

  const refreshCurrentDir = useCallback(() => {
    if (!currentDir) return;
    void api.refresh(currentDir).then(() => {
      void queryClient.invalidateQueries({ queryKey: ["dirs"] });
      void queryClient.invalidateQueries({ queryKey: ["npz-list"] });
    });
  }, [currentDir, queryClient]);

  useHotkeys(
    {
      ArrowLeft: () => void nav.go("file", "prev"),
      ArrowRight: () => void nav.go("file", "next"),
      ArrowUp: () => void nav.go("folder", "prev"),
      ArrowDown: () => void nav.go("folder", "next"),
      space: () => advanceToggle(tileCount),
      "1": () => setToggleIndex(0),
      "2": () => tileCount > 1 && setToggleIndex(1),
      "3": () => tileCount > 2 && setToggleIndex(2),
      "4": () => tileCount > 3 && setToggleIndex(3),
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

            {panel === "full" ? (
              <div className="min-h-0 flex-1">
                <ComparePanel />
              </div>
            ) : panel === "split" ? (
              <Group
                orientation="vertical"
                className="min-h-0 flex-1"
                defaultLayout={rightLayout.defaultLayout}
                onLayoutChanged={rightLayout.onLayoutChanged}
              >
                <Panel id="gallery" minSize="15" className="min-h-0">
                  <GalleryGrid />
                </Panel>
                <Separator className={HANDLE_CLASS} />
                <Panel id="compare" defaultSize="45" minSize="15" className="min-h-0">
                  <ComparePanel />
                </Panel>
              </Group>
            ) : (
              <div className="min-h-0 flex-1">
                <GalleryGrid />
              </div>
            )}
          </div>
        </Panel>
      </Group>

      <Lightbox />
    </div>
  );
}
