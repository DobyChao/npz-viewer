import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Layers,
  Maximize,
  Minimize2,
  Ratio,
  Repeat,
  Scan,
  X,
} from "lucide-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, versionOf } from "../../lib/api";
import { formatNumber, formatPercent } from "../../lib/format";
import { isTypingTarget } from "../../hooks/useHotkeys";
import { useCurrentNpz } from "../../hooks/useCurrentNpz";
import { useNpzNavigation } from "../../hooks/useNpzNavigation";
import { useAppStore } from "../../store/useAppStore";
import { useCompareStore } from "../../store/useCompareStore";
import { DEFAULT_VIEW_OPTIONS } from "../../lib/types";
import type { CompareLayout } from "../../lib/types";
import { Button, EmptyState, IconButton, SectionHeader, Select } from "../ui";
import { CompareTile } from "./CompareTile";
import type { TileSpec } from "./CompareTile";
import { SequenceBar } from "./SequenceBar";

const PIXEL_THROTTLE_MS = 120;

interface ImageSize {
  width: number;
  height: number;
}

function resolveLayout(layout: CompareLayout, count: number): Exclude<CompareLayout, "auto"> {
  if (layout !== "auto") return layout;
  if (count <= 1) return "1x1";
  if (count === 2) return "1x2";
  // Three tiles side by side beats a 2×2 grid with a hole in it.
  if (count === 3) return "1x3";
  return "2x2";
}

function gridClassFor(layout: Exclude<CompareLayout, "auto">): string {
  switch (layout) {
    case "1x1":
      return "grid-cols-1 grid-rows-1";
    case "1x2":
      return "grid-cols-2 grid-rows-1";
    case "2x1":
      return "grid-cols-1 grid-rows-2";
    case "1x3":
      return "grid-cols-3 grid-rows-1";
    case "3x1":
      return "grid-cols-1 grid-rows-3";
    case "2x2":
      return "grid-cols-2 grid-rows-2";
  }
}

export function ComparePanel() {
  const { path, meta, version } = useCurrentNpz();
  const nav = useNpzNavigation();

  const mode = useCompareStore((state) => state.mode);
  const items = useCompareStore((state) => state.items);
  const insideKeys = useCompareStore((state) => state.insideKeys);
  const layout = useCompareStore((state) => state.layout);
  const setLayout = useCompareStore((state) => state.setLayout);
  const toggleIndex = useCompareStore((state) => state.toggleIndex);
  const setToggleIndex = useCompareStore((state) => state.setToggleIndex);
  const advanceToggle = useCompareStore((state) => state.advanceToggle);
  const overlayEnabled = useCompareStore((state) => state.overlayEnabled);
  const overlaySource = useCompareStore((state) => state.overlaySource);
  const overlayPeek = useCompareStore((state) => state.overlayPeek);
  const lightbox = useAppStore((state) => state.lightbox);
  const equalHeight = useCompareStore((state) => state.equalHeight);
  const setEqualHeight = useCompareStore((state) => state.setEqualHeight);
  const setOverlayEnabled = useCompareStore((state) => state.setOverlayEnabled);
  const setOverlaySource = useCompareStore((state) => state.setOverlaySource);
  const setOverlayPeek = useCompareStore((state) => state.setOverlayPeek);
  const panel = useCompareStore((state) => state.panel);
  const setPanel = useCompareStore((state) => state.setPanel);
  const viewport = useCompareStore((state) => state.viewport);
  const setViewport = useCompareStore((state) => state.setViewport);
  const fitToken = useCompareStore((state) => state.fitToken);
  const actualToken = useCompareStore((state) => state.actualToken);
  const removeItem = useCompareStore((state) => state.removeItem);
  const toggleInsideKey = useCompareStore((state) => state.toggleInsideKey);
  const showPixelReadout = useCompareStore((state) => state.showPixelReadout);
  const sequence = useCompareStore((state) => state.sequence);
  const gamut = useAppStore((state) => state.gamut);

  const sequenceDriving =
    mode === "inside" && sequence.engaged && sequence.playhead !== null && Boolean(sequence.playPath);
  const tilePath = sequenceDriving ? sequence.playPath : path;
  const { data: playMeta } = useQuery({
    queryKey: ["npz-meta", tilePath],
    queryFn: () => api.meta(tilePath!),
    enabled: Boolean(tilePath) && mode === "inside" && !sequence.playing,
    placeholderData: keepPreviousData,
  });
  const tileMeta = playMeta ?? meta;
  const tileVersion = sequenceDriving ? "" : tileMeta ? versionOf(tileMeta) : version;
  const tileName = sequenceDriving
    ? (sequence.playName ?? tileMeta?.name ?? meta?.name ?? "")
    : (tileMeta?.name ?? meta?.name ?? "");

  const gridRef = useRef<HTMLDivElement | null>(null);
  const [naturalSizes, setNaturalSizes] = useState<Record<string, ImageSize>>({});
  const fittedSizeRef = useRef<string>("");
  const seenSignatureRef = useRef<string>("");
  const lastPixelFetch = useRef(0);
  const [readout, setReadout] = useState<{ x: number; y: number; values: (number | null)[] } | null>(
    null,
  );

  const tiles = useMemo<TileSpec[]>(() => {
    if (mode === "cross") {
      return items.map((item) => ({
        id: item.id,
        key: item.key,
        npzPath: item.npzPath,
        npzName: item.npzName,
        version: item.version,
        options: item.options,
        missing: false,
        removable: true,
      }));
    }
    if (!path || !tileMeta) return [];
    return insideKeys.map((key) => {
      const keyMeta = tileMeta.keys.find((candidate) => candidate.name === key);
      return {
        id: `inside::${key}`,
        key,
        npzPath: tilePath ?? path,
        npzName: tileName,
        version: tileVersion,
        options: DEFAULT_VIEW_OPTIONS,
        missing: tilePath != null && tileMeta.path === tilePath ? !keyMeta?.renderable : false,
        removable: true,
      };
    });
  }, [mode, items, insideKeys, path, meta, version, tileMeta, tilePath, tileName, tileVersion]);

  const signature = tiles.map((tile) => tile.id).join("|");
  const visibleTiles = toggleIndex !== null && tiles.length > 0 ? [tiles[toggleIndex % tiles.length]] : tiles;
  const effectiveLayout = resolveLayout(layout, visibleTiles.length);

  // Overlay is available whenever two tiles sit side by side. Hold X to overlay
  // (default); click the button to lock it on, then hold X to peek underneath.
  const overlayAvailable = tiles.length >= 2 && toggleIndex === null && panel !== "hidden";
  const overlaySourceIndex = overlayAvailable ? Math.min(overlaySource, tiles.length - 1) : null;
  const overlayVisible = overlayAvailable && overlayEnabled !== overlayPeek;

  // The first visible tile is the baseline: fitting, 1:1 and equal-height all key off it.
  const referenceSize = visibleTiles.length ? (naturalSizes[visibleTiles[0].id] ?? null) : null;
  const referenceSizeRef = useRef<ImageSize | null>(null);
  referenceSizeRef.current = referenceSize;

  const heightFactor = useCallback(
    (id: string) => {
      if (!equalHeight || !referenceSize) return 1;
      const size = naturalSizes[id];
      if (!size || size.height === 0) return 1;
      return referenceSize.height / size.height;
    },
    [equalHeight, referenceSize, naturalSizes],
  );

  const mixedSizes = useMemo(() => {
    const seen = new Set(
      tiles.map((tile) => {
        const size = naturalSizes[tile.id];
        return size ? `${size.width}x${size.height}` : "";
      }),
    );
    seen.delete("");
    return seen.size > 1;
  }, [tiles, naturalSizes]);

  // Hold X to overlay (or, when locked, to drop the top layer).
  useEffect(() => {
    if (!overlayAvailable || lightbox) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "x" && event.key !== "X") return;
      if (event.repeat) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      setOverlayPeek(event.type === "keydown");
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      setOverlayPeek(false);
    };
  }, [overlayAvailable, lightbox, setOverlayPeek]);

  const fit = useCallback(() => {
    const first = gridRef.current?.firstElementChild as HTMLElement | null;
    const size = referenceSizeRef.current;
    if (!first || !size || size.width === 0 || size.height === 0) return;
    if (first.clientWidth < 8 || first.clientHeight < 8) return;
    const scale =
      Math.min(first.clientWidth / size.width, first.clientHeight / size.height) * 0.98;
    setViewport(
      {
        scale,
        x: (first.clientWidth - size.width * scale) / 2,
        y: (first.clientHeight - size.height * scale) / 2,
      },
      "fit",
    );
  }, [setViewport]);

  // Stay fitted across panel resizes and grid changes, but never undo a manual zoom.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const refitIfFitted = () => {
      if (useCompareStore.getState().viewportFitted) fit();
    };
    const observer = new ResizeObserver(refitIfFitted);
    observer.observe(grid);
    refitIfFitted();
    return () => observer.disconnect();
  }, [fit, effectiveLayout, visibleTiles.length]);

  const handleNaturalSize = useCallback((id: string, size: ImageSize) => {
    setNaturalSizes((previous) => {
      const known = previous[id];
      if (known && known.width === size.width && known.height === size.height) return previous;
      return { ...previous, [id]: size };
    });
  }, []);

  // Forget measurements for tiles that are no longer on screen.
  useEffect(() => {
    if (signature === seenSignatureRef.current) return;
    seenSignatureRef.current = signature;
    const live = new Set(tiles.map((tile) => tile.id));
    setNaturalSizes((previous) => {
      const kept = Object.entries(previous).filter(([id]) => live.has(id));
      return kept.length === Object.keys(previous).length ? previous : Object.fromEntries(kept);
    });
  }, [signature, tiles]);

  // Refit on a change of the reference image's dimensions only. Stepping through files
  // of the same resolution is the main comparison workflow and has to preserve the zoom.
  useEffect(() => {
    if (!referenceSize) return;
    const dims = `${referenceSize.width}x${referenceSize.height}`;
    if (fittedSizeRef.current === dims) return;
    fittedSizeRef.current = dims;
    const frame = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(frame);
  }, [referenceSize, fit]);

  const actualSize = useCallback(() => {
    const first = gridRef.current?.firstElementChild as HTMLElement | null;
    const size = referenceSizeRef.current;
    if (!first || !size) return;
    if (first.clientWidth < 8 || first.clientHeight < 8) return;
    setViewport({
      scale: 1,
      x: (first.clientWidth - size.width) / 2,
      y: (first.clientHeight - size.height) / 2,
    });
  }, [setViewport]);

  const mountedTokens = useRef({ fit: fitToken, actual: actualToken });
  useEffect(() => {
    if (mountedTokens.current.fit !== fitToken) {
      mountedTokens.current.fit = fitToken;
      fit();
    }
    if (mountedTokens.current.actual !== actualToken) {
      mountedTokens.current.actual = actualToken;
      actualSize();
    }
  }, [fitToken, actualToken, fit, actualSize]);

  const handleHoverPixel = useCallback(
    (spec: TileSpec, x: number, y: number) => {
      if (!showPixelReadout || spec.missing || x < 0 || y < 0) return;
      const now = performance.now();
      if (now - lastPixelFetch.current < PIXEL_THROTTLE_MS) return;
      lastPixelFetch.current = now;
      void api
        .pixel(spec.npzPath, spec.key, x, y, spec.options.batch)
        .then((result) => setReadout({ x, y, values: result.values }))
        .catch(() => setReadout(null));
    },
    [showPixelReadout],
  );

  const removeTile = (tile: TileSpec) => {
    if (mode === "cross") removeItem(tile.id);
    else toggleInsideKey(tile.key);
  };

  return (
    <div className="flex h-full flex-col bg-zinc-950">
      <SectionHeader title="对比">
        <div className="flex items-center gap-1">
          <IconButton
            title="上一个 npz（←）"
            disabled={!nav.enabled || nav.busy}
            onClick={() => void nav.go("file", "prev")}
          >
            <ChevronLeft size={14} />
          </IconButton>
          <IconButton
            title="下一个 npz（→）"
            disabled={!nav.enabled || nav.busy}
            onClick={() => void nav.go("file", "next")}
          >
            <ChevronRight size={14} />
          </IconButton>
          <IconButton
            title="上一个兄弟文件夹的同序号 npz（↑）"
            disabled={!nav.enabled || nav.busy}
            onClick={() => void nav.go("folder", "prev")}
          >
            <ChevronUp size={14} />
          </IconButton>
          <IconButton
            title="下一个兄弟文件夹的同序号 npz（↓）"
            disabled={!nav.enabled || nav.busy}
            onClick={() => void nav.go("folder", "next")}
          >
            <ChevronDown size={14} />
          </IconButton>

          <span className="mx-1 h-4 w-px bg-zinc-800" />

          <span
            data-testid="compare-zoom"
            className="w-14 text-right font-mono text-[11px] text-zinc-400 tabular-nums"
          >
            {formatPercent(viewport.scale)}
          </span>
          <IconButton title="适应窗口（Ctrl+0）" onClick={fit}>
            <Scan size={14} />
          </IconButton>
          <IconButton title="100%（Ctrl+1）" onClick={actualSize}>
            <Ratio size={14} />
          </IconButton>

          <Select
            title="网格布局"
            value={layout}
            options={[
              { value: "auto", label: "自动" },
              { value: "1x1", label: "1×1" },
              { value: "1x2", label: "并排" },
              { value: "2x1", label: "上下" },
              { value: "1x3", label: "三列" },
              { value: "3x1", label: "三行" },
              { value: "2x2", label: "2×2" },
            ]}
            onChange={(value) => setLayout(value as CompareLayout)}
          />

          <Button
            title="A/B 翻转：只显示一张，按空格在已选图之间切换"
            active={toggleIndex !== null}
            disabled={tiles.length < 2}
            onClick={() => (toggleIndex === null ? setToggleIndex(0) : setToggleIndex(null))}
          >
            <Repeat size={13} /> A/B
          </Button>

          <Button
            title={
              overlayEnabled
                ? "覆盖已锁定：按住 X 临时移开。再点一次改回按住 X 才覆盖"
                : "按住 X 把覆盖源叠到第 1 格；点击锁定覆盖"
            }
            data-testid="overlay-toggle"
            data-locked={overlayEnabled ? "true" : "false"}
            active={overlayEnabled && overlayAvailable}
            disabled={tiles.length < 2}
            onClick={() => setOverlayEnabled(!overlayEnabled)}
          >
            <Layers size={13} /> 覆盖
          </Button>

          <Button
            title="等高：把各图等比缩放到与第 1 格相同的显示高度，尺寸不同时才有意义"
            data-testid="equal-height-toggle"
            active={equalHeight}
            disabled={tiles.length < 2}
            onClick={() => setEqualHeight(!equalHeight)}
          >
            <ArrowUpDown size={13} /> 等高
            {mixedSizes && !equalHeight && <span className="text-amber-400">·</span>}
          </Button>

          <span className="mx-1 h-4 w-px bg-zinc-800" />

          <IconButton
            title={panel === "full" ? "还原分栏（F）" : "占满右侧（F）"}
            active={panel === "full"}
            onClick={() => setPanel(panel === "full" ? "split" : "full")}
          >
            {panel === "full" ? <Minimize2 size={14} /> : <Maximize size={14} />}
          </IconButton>
          <IconButton title="关闭对比面板（Esc）" onClick={() => setPanel("hidden")}>
            <X size={14} />
          </IconButton>
        </div>
      </SectionHeader>

      {nav.message && (
        <div className="shrink-0 bg-amber-500/10 px-3 py-1 text-[11px] text-amber-400">
          {nav.message}
        </div>
      )}

      {tiles.length === 0 ? (
        <EmptyState>
          {mode === "cross"
            ? "还没有加入对比的图片：在 gallery 卡片上点「对比」。"
            : "还没有勾选 key：在上方的对比条里勾选要比较的 key。"}
        </EmptyState>
      ) : (
        <div
          ref={gridRef}
          data-testid="compare-grid"
          className={clsx("grid min-h-0 flex-1 gap-px bg-zinc-800", gridClassFor(effectiveLayout))}
        >
          {visibleTiles.map((tile, index) => (
            <CompareTile
              key={tile.id}
              spec={tile}
              index={toggleIndex !== null ? toggleIndex : index}
              viewport={viewport}
              scaleFactor={heightFactor(tile.id)}
              overlay={
                overlaySourceIndex !== null && index === 0
                  ? {
                      spec: tiles[overlaySourceIndex],
                      index: overlaySourceIndex,
                      hidden: !overlayVisible,
                      scaleFactor: heightFactor(tiles[overlaySourceIndex].id),
                    }
                  : undefined
              }
              isOverlaySource={
                overlaySourceIndex !== null &&
                index === overlaySourceIndex &&
                (overlayEnabled || overlayVisible)
              }
              onPickOverlaySource={
                overlaySourceIndex !== null && index > 0 && index !== overlaySourceIndex
                  ? () => setOverlaySource(index)
                  : undefined
              }
              onNaturalSize={handleNaturalSize}
              onHoverPixel={handleHoverPixel}
              onRemove={tile.removable ? () => removeTile(tile) : undefined}
            />
          ))}
        </div>
      )}

      {mode === "inside" && path && insideKeys.length > 0 && (
        <SequenceBar
          path={path}
          keys={insideKeys}
          gamut={gamut}
          layout={layout}
          equalHeight={equalHeight}
          viewport={viewport}
          measureTile={() => {
            const tile = gridRef.current?.firstElementChild as HTMLElement | null;
            return { width: tile?.clientWidth ?? 0, height: tile?.clientHeight ?? 0 };
          }}
          naturalSizes={insideKeys.map(
            (key) => naturalSizes[`inside::${key}`] ?? { width: 0, height: 0 },
          )}
        />
      )}

      <div className="flex h-6 shrink-0 items-center gap-4 border-t border-zinc-800 bg-zinc-900/60 px-3 font-mono text-[10px] text-zinc-500 tabular-nums">
        {toggleIndex !== null && (
          <button
            type="button"
            className="text-cyan-400"
            onClick={() => advanceToggle(tiles.length)}
          >
            A/B {toggleIndex + 1} / {tiles.length} · 空格切换
          </button>
        )}
        {overlaySourceIndex !== null && (
          <span data-testid="overlay-status" className="text-amber-400">
            {overlayEnabled
              ? overlayVisible
                ? `覆盖 ${overlaySourceIndex + 1} → 1 · 按住 X 移开覆盖层`
                : "已移开，松开 X 恢复"
              : overlayVisible
                ? `覆盖 ${overlaySourceIndex + 1} → 1 · 松开 X 移开`
                : `按住 X 覆盖 ${overlaySourceIndex + 1} → 1`}
          </span>
        )}
        {equalHeight && referenceSize && (
          <span data-testid="equal-height-status" className="text-cyan-400">
            等高 · 基准 {referenceSize.height}px
          </span>
        )}
        {readout ? (
          <span data-testid="compare-readout" className="flex min-w-0 gap-4">
            <span>
              x {readout.x} y {readout.y}
            </span>
            <span className="truncate">
              [{readout.values.map((value) => formatNumber(value)).join(", ")}]
            </span>
          </span>
        ) : (
          <span className="text-zinc-700">
            滚轮缩放 · 拖拽平移 · 所有面板同步{showPixelReadout ? " · 悬停读取原始像素值" : ""}
          </span>
        )}
      </div>
    </div>
  );
}
