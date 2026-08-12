import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize, Scan, X } from "lucide-react";
import { renderUrl } from "../../lib/api";
import { formatPercent } from "../../lib/format";
import { useImageResource } from "../../hooks/useImageResource";
import { usePanZoom } from "../../hooks/usePanZoom";
import { useCurrentNpz } from "../../hooks/useCurrentNpz";
import { useAppStore } from "../../store/useAppStore";
import { DEFAULT_VIEW_OPTIONS } from "../../lib/types";
import { IDENTITY_VIEWPORT } from "../../store/useCompareStore";
import type { Viewport } from "../../store/useCompareStore";
import { ErrorBox, IconButton, Spinner } from "../ui";

export function Lightbox() {
  const target = useAppStore((state) => state.lightbox);
  const close = useAppStore((state) => state.closeLightbox);
  const openLightbox = useAppStore((state) => state.openLightbox);
  const gamut = useAppStore((state) => state.gamut);
  const { meta } = useCurrentNpz();
  const [viewport, setViewport] = useState<Viewport>(IDENTITY_VIEWPORT);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const panZoom = usePanZoom(viewport, setViewport);

  const url = useMemo(
    () =>
      target
        ? renderUrl({
            path: target.path,
            key: target.key,
            gamut,
            version: target.version,
            options: target.options,
          })
        : null,
    [target, gamut],
  );

  const { src, state, error } = useImageResource(url);

  // Walk between the renderable keys of the same npz with the arrow keys.
  const siblings = useMemo(
    () => (meta?.keys ?? []).filter((key) => key.renderable).map((key) => key.name),
    [meta],
  );

  // Depend on `fit` rather than the whole pan/zoom object: the hook returns a fresh
  // object every render, which would re-run this effect and loop through setSize.
  const { fit } = panZoom;
  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      setSize({ width: image.naturalWidth, height: image.naturalHeight });
      fit(image.naturalWidth, image.naturalHeight);
    };
    image.src = src;
    return () => {
      cancelled = true;
    };
  }, [src, fit]);

  const step = useCallback(
    (delta: number) => {
      if (!target || siblings.length === 0) return;
      const index = siblings.indexOf(target.key);
      if (index < 0) return;
      const nextKey = siblings[(index + delta + siblings.length) % siblings.length];
      // Per-key overrides (channel, alpha mode, ...) rarely transfer, so start clean.
      openLightbox({ ...target, key: nextKey, options: DEFAULT_VIEW_OPTIONS });
    },
    [target, siblings, openLightbox],
  );

  useEffect(() => {
    if (!target) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      else if (event.key === "ArrowRight") step(1);
      else if (event.key === "ArrowLeft") step(-1);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [target, step, close]);

  if (!target) return null;

  return (
    <div data-testid="lightbox" className="fixed inset-0 z-40 flex flex-col bg-black/92">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-900/80 px-3">
        <span className="truncate font-mono text-xs text-zinc-200">
          {target.key}
          <span className="ml-2 text-zinc-600">{target.path.split("/").slice(-1)[0]}</span>
        </span>
        {size && (
          <span className="shrink-0 font-mono text-[11px] text-zinc-600 tabular-nums">
            {size.width}×{size.height}
          </span>
        )}
        <span
          data-testid="lightbox-zoom"
          className="shrink-0 font-mono text-[11px] text-zinc-400 tabular-nums"
        >
          {formatPercent(viewport.scale)}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <IconButton title="上一个 key（←）" onClick={() => step(-1)}>
            <ChevronLeft size={14} />
          </IconButton>
          <IconButton title="下一个 key（→）" onClick={() => step(1)}>
            <ChevronRight size={14} />
          </IconButton>
          <IconButton
            title="适应窗口"
            onClick={() => size && panZoom.fit(size.width, size.height)}
          >
            <Scan size={14} />
          </IconButton>
          <IconButton title="100%" onClick={panZoom.actualSize}>
            <Maximize size={14} />
          </IconButton>
          <IconButton title="关闭（Esc）" onClick={close}>
            <X size={14} />
          </IconButton>
        </div>
      </div>

      <div
        ref={panZoom.containerRef}
        className="checkerboard relative min-h-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
        onPointerDown={panZoom.onPointerDown}
        onPointerMove={panZoom.onPointerMove}
        onPointerUp={panZoom.onPointerUp}
        onPointerCancel={panZoom.onPointerUp}
      >
        {src && (
          <img
            data-testid="lightbox-image"
            src={src}
            alt={target.key}
            draggable={false}
            className={viewport.scale >= 1.5 ? "pixelated" : undefined}
            style={{
              position: "absolute",
              transformOrigin: "0 0",
              transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
              // See CompareTile: preflight's max-width:100% would pre-shrink wide images.
              maxWidth: "none",
            }}
          />
        )}
        {state === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Spinner />
          </div>
        )}
        {state === "error" && error && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <ErrorBox error={error} />
          </div>
        )}
      </div>
    </div>
  );
}
