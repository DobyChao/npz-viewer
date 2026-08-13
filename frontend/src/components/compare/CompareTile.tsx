import { useEffect } from "react";
import clsx from "clsx";
import { FileQuestion, Layers, X } from "lucide-react";
import { renderUrl } from "../../lib/api";
import { useImageResource } from "../../hooks/useImageResource";
import { usePanZoom } from "../../hooks/usePanZoom";
import { useAppStore } from "../../store/useAppStore";
import { useCompareStore } from "../../store/useCompareStore";
import type { Viewport } from "../../store/useCompareStore";
import type { ViewOptions } from "../../lib/types";
import { ErrorBox, IconButton, Spinner } from "../ui";

export interface TileSpec {
  id: string;
  key: string;
  npzPath: string;
  npzName: string;
  version: string;
  options: ViewOptions;
  missing: boolean;
  removable: boolean;
}

export interface OverlayLayer {
  /** Tile whose image is painted on top of this one. */
  spec: TileSpec;
  index: number;
  hidden: boolean;
  /** Its own equal-height factor, so a half-res overlay still lines up. */
  scaleFactor: number;
}

function layerStyle(viewport: Viewport, scaleFactor: number): React.CSSProperties {
  return {
    position: "absolute",
    transformOrigin: "0 0",
    transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale * scaleFactor})`,
    // Tailwind's preflight clamps images to max-width:100%, which would shrink a wide
    // image before the transform and make the zoom percentage and pixel readout lie.
    maxWidth: "none",
  };
}

export function CompareTile({
  spec,
  viewport,
  index,
  scaleFactor = 1,
  overlay,
  isOverlaySource,
  onPickOverlaySource,
  onNaturalSize,
  onHoverPixel,
  onRemove,
}: {
  spec: TileSpec;
  viewport: Viewport;
  index: number;
  /** Extra per-image zoom on top of the shared viewport; 1 unless heights are matched. */
  scaleFactor?: number;
  overlay?: OverlayLayer;
  isOverlaySource?: boolean;
  onPickOverlaySource?: () => void;
  onNaturalSize: (id: string, size: { width: number; height: number }) => void;
  onHoverPixel: (spec: TileSpec, x: number, y: number) => void;
  onRemove?: () => void;
}) {
  const gamut = useAppStore((state) => state.gamut);
  const setViewport = useCompareStore((state) => state.setViewport);
  const panZoom = usePanZoom(viewport, setViewport);

  const urlFor = (target: TileSpec) =>
    target.missing
      ? null
      : renderUrl({
          path: target.npzPath,
          key: target.key,
          gamut,
          version: target.version,
          options: target.options,
        });

  const url = urlFor(spec);
  const { src, state, error } = useImageResource(url);
  // Re-requests the source tile's image, which the browser answers from cache or a 304.
  // Worth it to keep the two tiles independent instead of threading blobs between them.
  const overlayImage = useImageResource(overlay ? urlFor(overlay.spec) : null);

  useEffect(() => {
    if (!src) return;
    const image = new Image();
    image.onload = () =>
      onNaturalSize(spec.id, { width: image.naturalWidth, height: image.naturalHeight });
    image.src = src;
  }, [src, spec.id, onNaturalSize]);

  if (spec.missing) {
    return (
      <div
        data-testid="compare-tile"
        data-key={spec.key}
        data-missing="true"
        className="relative flex min-h-0 min-w-0 flex-col items-center justify-center gap-2 border border-dashed border-zinc-700 bg-zinc-900/40"
      >
        <FileQuestion size={22} className="text-zinc-700" />
        <div className="px-3 text-center">
          <div className="font-mono text-xs text-zinc-500">KEY NOT FOUND</div>
          <div className="mt-0.5 font-mono text-[11px] text-zinc-600">{spec.key}</div>
          <div className="mt-1 truncate text-[10px] text-zinc-700">{spec.npzName}</div>
        </div>
        {onRemove && (
          <IconButton
            title="从对比中移除（当前 npz 没有这个 key）"
            data-testid="remove-tile"
            className="absolute top-1 right-1 h-5 w-5 bg-black/65"
            onClick={onRemove}
          >
            <X size={11} />
          </IconButton>
        )}
      </div>
    );
  }

  return (
    <div
      ref={panZoom.containerRef}
      data-testid="compare-tile"
      data-key={spec.key}
      data-overlay={overlay ? (overlay.hidden ? "hidden" : "on") : undefined}
      className="checkerboard relative min-h-0 min-w-0 cursor-grab overflow-hidden border border-zinc-800 active:cursor-grabbing"
      onPointerDown={panZoom.onPointerDown}
      onPointerMove={(event) => {
        panZoom.onPointerMove(event);
        const rect = event.currentTarget.getBoundingClientRect();
        // Divide by the effective scale, or a stretched image would report the wrong source pixel.
        const effective = viewport.scale * scaleFactor;
        const imageX = Math.floor((event.clientX - rect.left - viewport.x) / effective);
        const imageY = Math.floor((event.clientY - rect.top - viewport.y) / effective);
        onHoverPixel(spec, imageX, imageY);
      }}
      onPointerUp={panZoom.onPointerUp}
      onPointerCancel={panZoom.onPointerUp}
    >
      {src && (
        <img
          src={src}
          alt={spec.key}
          data-testid="compare-image"
          draggable={false}
          className={clsx(viewport.scale * scaleFactor >= 1.5 && "pixelated")}
          style={layerStyle(viewport, scaleFactor)}
        />
      )}

      {overlay && overlayImage.src && !overlay.hidden && (
        <img
          src={overlayImage.src}
          alt={`${overlay.spec.key} 覆盖层`}
          data-testid="compare-overlay"
          draggable={false}
          className={clsx(viewport.scale * overlay.scaleFactor >= 1.5 && "pixelated")}
          style={layerStyle(viewport, overlay.scaleFactor)}
        />
      )}

      {state === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner />
        </div>
      )}
      {state === "error" && error && (
        <div className="absolute inset-0 flex items-center justify-center p-3">
          <ErrorBox error={error} compact />
        </div>
      )}

      <div className="pointer-events-none absolute top-1 left-1 flex max-w-[calc(100%-4rem)] items-center gap-1.5 rounded bg-black/65 px-1.5 py-0.5">
        <span className="font-mono text-[10px] text-cyan-400">
          {index + 1}
          {overlay && ` ← ${overlay.index + 1}`}
        </span>
        {isOverlaySource && <span className="text-[10px] text-amber-400">覆盖源</span>}
        <span
          className={clsx(
            "truncate font-mono text-[11px]",
            overlay && !overlay.hidden ? "text-amber-400" : "text-zinc-200",
          )}
        >
          {overlay && !overlay.hidden ? overlay.spec.key : spec.key}
        </span>
        <span className="truncate text-[10px] text-zinc-500">
          {overlay && !overlay.hidden ? overlay.spec.npzName : spec.npzName}
        </span>
      </div>

      <div className="absolute top-1 right-1 flex items-center gap-1">
        {onPickOverlaySource && (
          <IconButton
            title="用这一格作为覆盖源"
            data-testid="pick-overlay-source"
            className="h-5 w-5 bg-black/65"
            onClick={onPickOverlaySource}
          >
            <Layers size={11} />
          </IconButton>
        )}
        {onRemove && (
          <IconButton
            title="从对比中移除"
            data-testid="remove-tile"
            className="h-5 w-5 bg-black/65"
            onClick={onRemove}
          >
            <X size={11} />
          </IconButton>
        )}
      </div>
    </div>
  );
}
