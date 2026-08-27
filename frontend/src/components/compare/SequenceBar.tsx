import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Pause, Play, Locate } from "lucide-react";
import { api } from "../../lib/api";
import { dirname } from "../../lib/format";
import { useHotkeys } from "../../hooks/useHotkeys";
import { rangeReady, useSequencePlayback } from "../../hooks/useSequencePlayback";
import { useAppStore } from "../../store/useAppStore";
import { useCompareStore } from "../../store/useCompareStore";
import type { CompareLayout, Gamut } from "../../lib/types";
import { Button, IconButton } from "../ui";
import { ExportDialog } from "./ExportDialog";
import type { Viewport } from "../../store/useCompareStore";

export function SequenceBar({
  path,
  keys,
  gamut,
  layout,
  equalHeight,
  viewport,
  measureTile,
  naturalSizes,
}: {
  path: string;
  keys: string[];
  gamut: Gamut;
  layout: CompareLayout;
  equalHeight: boolean;
  viewport: Viewport;
  measureTile: () => { width: number; height: number };
  naturalSizes: { width: number; height: number }[];
}) {
  const sequence = useCompareStore((state) => state.sequence);
  const setSequence = useCompareStore((state) => state.setSequence);
  const resetSequence = useCompareStore((state) => state.resetSequence);
  const togglePlayback = useCompareStore((state) => state.togglePlayback);
  const jumpToFile = useAppStore((state) => state.jumpToFile);
  const [exportOpen, setExportOpen] = useState(false);

  const dir = dirname(path);
  const prevDir = useRef(dir);
  useEffect(() => {
    if (prevDir.current === dir) return;
    prevDir.current = dir;
    resetSequence();
  }, [dir, resetSequence]);

  useSequencePlayback({ path, keys, gamut, enabled: keys.length > 0 });

  const locateQuery = useQuery({
    queryKey: ["nav-locate", path],
    queryFn: () => api.locate(path),
  });
  const total = locateQuery.data?.total ?? 0;
  const currentIndex = locateQuery.data?.index ?? 0;

  const startName = useQuery({
    queryKey: ["nav-at", path, sequence.start],
    queryFn: () => api.navAt(path, sequence.start!),
    enabled: sequence.start !== null,
  });
  const endName = useQuery({
    queryKey: ["nav-at", path, sequence.end],
    queryFn: () => api.navAt(path, sequence.end!),
    enabled: sequence.end !== null,
  });
  const playName = useQuery({
    queryKey: ["nav-at", path, sequence.playhead],
    queryFn: () => api.navAt(path, sequence.playhead!),
    enabled: sequence.playhead !== null,
  });

  const canPlay = rangeReady(sequence.start, sequence.end);
  const canExport = canPlay && keys.length > 0;

  useHotkeys(
    {
      p: () => {
        if (canPlay) togglePlayback();
      },
      P: () => {
        if (canPlay) togglePlayback();
      },
    },
    keys.length > 0,
  );

  const setBound = (field: "start" | "end", raw: string) => {
    if (raw === "") {
      setSequence({ [field]: null, playing: false });
      return;
    }
    const oneBased = Number(raw);
    if (!Number.isFinite(oneBased)) return;
    const index = Math.min(Math.max(0, Math.round(oneBased) - 1), Math.max(0, total - 1));
    setSequence({ [field]: index, playing: false });
  };

  return (
    <div
      data-testid="sequence-bar"
      className="flex h-8 shrink-0 items-center gap-2 border-t border-zinc-800 bg-zinc-900/80 px-3 text-[11px] text-zinc-400"
    >
      <IconButton
        title={sequence.playing ? "暂停（P）" : "播放（P）"}
        data-testid="sequence-play"
        disabled={!canPlay}
        active={sequence.playing}
        onClick={togglePlayback}
      >
        {sequence.playing ? <Pause size={13} /> : <Play size={13} />}
      </IconButton>

      <label className="flex items-center gap-1">
        起
        <input
          data-testid="sequence-start"
          type="number"
          min={1}
          max={Math.max(1, total)}
          placeholder="—"
          value={sequence.start === null ? "" : sequence.start + 1}
          onChange={(event) => setBound("start", event.target.value)}
          className="w-12 rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 font-mono text-[11px] text-zinc-200"
        />
        <span className="max-w-28 truncate font-mono text-zinc-600">
          {startName.data?.name ?? ""}
        </span>
      </label>

      <label className="flex items-center gap-1">
        止
        <input
          data-testid="sequence-end"
          type="number"
          min={1}
          max={Math.max(1, total)}
          placeholder="—"
          value={sequence.end === null ? "" : sequence.end + 1}
          onChange={(event) => setBound("end", event.target.value)}
          className="w-12 rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 font-mono text-[11px] text-zinc-200"
        />
        <span className="max-w-28 truncate font-mono text-zinc-600">
          {endName.data?.name ?? ""}
        </span>
      </label>

      <input
        data-testid="sequence-scrubber"
        type="range"
        disabled={!canPlay}
        min={sequence.start ?? 0}
        max={sequence.end ?? 0}
        value={sequence.playhead ?? sequence.start ?? 0}
        onChange={(event) =>
          setSequence({ playhead: Number(event.target.value), playing: false })
        }
        className="h-1 min-w-16 flex-1 accent-cyan-500"
      />

      <span data-testid="sequence-playhead" className="shrink-0 font-mono text-zinc-500 tabular-nums">
        {playName.data?.name ?? locateQuery.data?.name ?? "—"} ·{" "}
        {(sequence.playhead ?? currentIndex) + 1}/{total || "—"}
      </span>

      <label className="flex items-center gap-1">
        fps
        <input
          type="number"
          min={1}
          max={60}
          value={sequence.fps}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (!Number.isFinite(next)) return;
            setSequence({ fps: Math.min(60, Math.max(1, next)) });
          }}
          className="w-10 rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 font-mono text-[11px] text-zinc-200"
        />
      </label>

      <Button
        title="把文件列表跳到 playhead 对应的 npz"
        disabled={sequence.playhead === null || !playName.data}
        onClick={() => {
          if (playName.data) jumpToFile(playName.data.path, playName.data.index);
        }}
      >
        <Locate size={12} /> 定位
      </Button>

      <Button
        data-testid="sequence-export"
        disabled={!canExport}
        title={canExport ? "导出宫格 MP4" : "先选起止帧"}
        onClick={() => setExportOpen(true)}
      >
        <Download size={12} /> 导出
      </Button>

      {exportOpen && canExport && sequence.start !== null && sequence.end !== null && (
        <ExportDialog
          path={path}
          keys={keys}
          start={sequence.start}
          end={sequence.end}
          fps={sequence.fps}
          layout={layout}
          gamut={gamut}
          equalHeight={equalHeight}
          viewport={viewport}
          tileSize={measureTile()}
          naturalSizes={naturalSizes}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}
