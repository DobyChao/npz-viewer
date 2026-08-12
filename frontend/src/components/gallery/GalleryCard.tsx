import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Columns2, Maximize2 } from "lucide-react";
import { api, renderUrl } from "../../lib/api";
import { formatNumber, formatShape } from "../../lib/format";
import { useInView } from "../../hooks/useInView";
import { useImageResource } from "../../hooks/useImageResource";
import { useAppStore } from "../../store/useAppStore";
import { useCompareStore } from "../../store/useCompareStore";
import { DEFAULT_VIEW_OPTIONS } from "../../lib/types";
import type { KeyKind, KeyMeta, ViewOptions } from "../../lib/types";
import { Button, ErrorBox, IconButton, Spinner } from "../ui";
import { DataCard } from "./DataCard";
import { KeyControls } from "./KeyControls";

const KIND_STYLES: Record<KeyKind, string> = {
  rgb: "bg-sky-500/15 text-sky-300",
  rgba: "bg-indigo-500/15 text-indigo-300",
  gray: "bg-zinc-500/20 text-zinc-300",
  gainmap: "bg-amber-500/15 text-amber-300",
  stack: "bg-violet-500/15 text-violet-300",
  table: "bg-emerald-500/15 text-emerald-300",
  scalar: "bg-emerald-500/15 text-emerald-300",
  raw: "bg-zinc-700/40 text-zinc-400",
};

export function GalleryCard({
  path,
  npzName,
  version,
  meta,
}: {
  path: string;
  npzName: string;
  version: string;
  meta: KeyMeta;
}) {
  const globalGamut = useAppStore((state) => state.gamut);
  const openLightbox = useAppStore((state) => state.openLightbox);
  const addItem = useCompareStore((state) => state.addItem);
  const compareItems = useCompareStore((state) => state.items);
  const compareMode = useCompareStore((state) => state.mode);
  const [options, setOptions] = useState<ViewOptions>(DEFAULT_VIEW_OPTIONS);
  const { ref, inView } = useInView();

  const url = useMemo(
    () =>
      meta.renderable
        ? renderUrl({ path, key: meta.name, gamut: globalGamut, version, options })
        : null,
    [meta.renderable, meta.name, path, globalGamut, version, options],
  );

  const { src, state, error } = useImageResource(url, { enabled: inView && meta.renderable });

  const { data: stats } = useQuery({
    queryKey: ["npz-stats", path, meta.name, options.batch],
    queryFn: () => api.stats(path, meta.name, meta.batch !== null ? options.batch : undefined),
    enabled: inView && meta.renderable,
  });

  const inCompare = compareItems.some((item) => item.id === `${path}::${meta.name}`);
  const compareFull = compareItems.length >= 4;

  return (
    <div
      ref={ref}
      data-testid="gallery-card"
      data-key={meta.name}
      className="flex flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50"
    >
      <div className="flex items-center gap-2 border-b border-zinc-800 px-2.5 py-1.5">
        <span className="truncate font-mono text-xs text-zinc-200" title={meta.name}>
          {meta.name}
        </span>
        <span
          className={clsx("shrink-0 rounded px-1.5 py-0.5 text-[10px]", KIND_STYLES[meta.kind])}
        >
          {meta.kind}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-600">
          {formatShape(meta.shape)} · {meta.dtype}
        </span>
      </div>

      {meta.renderable ? (
        <>
          <button
            type="button"
            data-testid="lightbox-open"
            data-key={meta.name}
            className="checkerboard group relative flex h-52 w-full items-center justify-center overflow-hidden"
            onClick={() =>
              src && openLightbox({ path, version, key: meta.name, options })
            }
            title="点击放大"
          >
            {src && (
              <img src={src} alt={meta.name} className="max-h-full max-w-full object-contain" />
            )}
            {!src && state === "loading" && <Spinner />}
            {!src && state === "idle" && <div className="text-[11px] text-zinc-700">等待载入</div>}
            {state === "error" && error && (
              <div className="max-w-full p-2">
                <ErrorBox error={error} compact />
              </div>
            )}
            {src && (
              <span className="pointer-events-none absolute right-1.5 bottom-1.5 rounded bg-black/60 p-1 opacity-0 transition-opacity group-hover:opacity-100">
                <Maximize2 size={12} className="text-zinc-200" />
              </span>
            )}
          </button>

          {stats && (
            <div className="flex flex-wrap gap-x-3 border-t border-zinc-800/60 px-2.5 py-1 font-mono text-[10px] text-zinc-500 tabular-nums">
              <span>min {formatNumber(stats.min)}</span>
              <span>max {formatNumber(stats.max)}</span>
              <span>mean {formatNumber(stats.mean)}</span>
              {stats.nan_count > 0 && (
                <span className="text-amber-500">nan {stats.nan_count.toLocaleString()}</span>
              )}
            </div>
          )}

          <div className="flex items-center gap-1.5 border-t border-zinc-800 px-2.5 py-1.5">
            <KeyControls
              meta={meta}
              options={options}
              onChange={(patch) => setOptions((current) => ({ ...current, ...patch }))}
            />
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Button
                title={
                  compareMode === "inside"
                    ? "当前是文件内对比模式，请在上方勾选 key"
                    : inCompare
                      ? "已在对比面板中"
                      : compareFull
                        ? "对比面板最多 4 张"
                        : "加入对比"
                }
                active={inCompare}
                disabled={compareMode === "inside" || (compareFull && !inCompare)}
                onClick={() =>
                  addItem({
                    npzPath: path,
                    npzName,
                    version,
                    key: meta.name,
                    options,
                  })
                }
              >
                <Columns2 size={13} /> 对比
              </Button>
              <IconButton
                title="全屏查看"
                disabled={!src}
                onClick={() => openLightbox({ path, version, key: meta.name, options })}
              >
                <Maximize2 size={13} />
              </IconButton>
            </div>
          </div>
        </>
      ) : (
        <DataCard path={path} meta={meta} />
      )}

      {meta.note && (
        <div className="border-t border-zinc-800/60 px-2.5 py-1 text-[10px] text-zinc-600">
          {meta.note}
        </div>
      )}
    </div>
  );
}
