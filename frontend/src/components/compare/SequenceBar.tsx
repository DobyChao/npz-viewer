import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Film, Pause, Play, Locate } from "lucide-react";
import { api, versionOf } from "../../lib/api";
import { dirname } from "../../lib/format";
import { clearNavCache, loadSibling, peekSibling } from "../../lib/navCache";
import { ensureUrls, frameReady, urlsFor } from "../../lib/sequenceFrames";
import { useHotkeys } from "../../hooks/useHotkeys";
import { rangeReady, useSequencePlayback } from "../../hooks/useSequencePlayback";
import { useAppStore } from "../../store/useAppStore";
import { useCompareStore } from "../../store/useCompareStore";
import type { CompareLayout, Gamut, VideoExportKey } from "../../lib/types";
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
  op = null,
  exportCells,
}: {
  path: string;
  keys: string[];
  gamut: Gamut;
  layout: CompareLayout;
  equalHeight: boolean;
  viewport: Viewport;
  measureTile: () => { width: number; height: number };
  naturalSizes: { width: number; height: number }[];
  op?: { id: string; left: string; right: string } | null;
  exportCells?: VideoExportKey[];
}) {
  const sequence = useCompareStore((state) => state.sequence);
  const setSequence = useCompareStore((state) => state.setSequence);
  const resetSequence = useCompareStore((state) => state.resetSequence);
  const exitSequence = useCompareStore((state) => state.exitSequence);
  const jumpToFile = useAppStore((state) => state.jumpToFile);
  const [exportOpen, setExportOpen] = useState(false);
  const seekGen = useRef(0);
  const seekTimer = useRef(0);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const opRef = useRef(op);
  opRef.current = op;
  const gamutRef = useRef(gamut);
  gamutRef.current = gamut;
  const pathRef = useRef(path);
  pathRef.current = path;

  const dir = dirname(path);
  const prevDir = useRef(dir);
  const prevPath = useRef(path);

  useEffect(() => {
    if (prevDir.current === dir) return;
    prevDir.current = dir;
    prevPath.current = path;
    resetSequence();
  }, [dir, path, resetSequence]);

  // File-list click changes `path`. Locate sets it to playPath and must stay engaged.
  useEffect(() => {
    if (prevPath.current === path) return;
    prevPath.current = path;
    const current = useCompareStore.getState().sequence;
    if (!current.engaged) return;
    if (current.playPath && path === current.playPath) return;
    exitSequence();
  }, [path, exitSequence]);

  useSequencePlayback({
    path,
    keys,
    gamut,
    enabled: keys.length > 0 && sequence.engaged,
    op,
  });

  const locateQuery = useQuery({
    queryKey: ["nav-locate", path],
    queryFn: () => api.locate(path),
  });
  const total = locateQuery.data?.total ?? 0;
  const currentIndex = locateQuery.data?.index ?? 0;

  const startName = useQuery({
    queryKey: ["nav-at", path, sequence.start],
    queryFn: () => loadSibling(path, sequence.start!),
    enabled: sequence.start !== null,
  });
  const endName = useQuery({
    queryKey: ["nav-at", path, sequence.end],
    queryFn: () => loadSibling(path, sequence.end!),
    enabled: sequence.end !== null,
  });
  const playName = useQuery({
    queryKey: ["nav-at", path, sequence.playhead],
    queryFn: () => loadSibling(path, sequence.playhead!),
    enabled: sequence.engaged && sequence.playhead !== null && !sequence.playName,
  });

  const canExport = rangeReady(sequence.start, sequence.end) && keys.length > 0;

  const commitSeek = async (index: number, restamp: boolean, gen: number) => {
    const anchor = pathRef.current;
    if (restamp) clearNavCache(dirname(anchor));
    try {
      const file = await loadSibling(anchor, index);
      if (gen !== seekGen.current) return;
      await ensureUrls(urlsFor(file, keysRef.current, gamutRef.current, opRef.current));
      if (gen !== seekGen.current) return;
      const latest = useCompareStore.getState().sequence;
      if (!latest.engaged || latest.playhead !== index) return;
      setSequence({
        playPath: file.path,
        playName: file.name,
        playVersion: versionOf(file),
      });
    } catch {
      // Keep the last painted frame; the scrubber/playhead already moved.
    }
  };

  const seekTo = (index: number, playing: boolean, opts?: { restamp?: boolean; defer?: boolean }) => {
    const restamp = opts?.restamp ?? false;
    const defer = opts?.defer ?? false;
    window.clearTimeout(seekTimer.current);
    seekGen.current += 1;
    const gen = seekGen.current;

    // Arrow-step a cached neighbour: swap immediately. Scrubber must not take
    // this path — dragging through the prefetch window would flash every hit.
    if (!defer && !restamp) {
      const cached = peekSibling(pathRef.current, index);
      if (cached && frameReady(cached, keysRef.current, gamutRef.current, opRef.current)) {
        setSequence({
          engaged: true,
          playing,
          playhead: index,
          playPath: cached.path,
          playName: cached.name,
          playVersion: versionOf(cached),
        });
        return;
      }
    }

    setSequence({
      engaged: true,
      playing,
      playhead: index,
    });
    if (defer) {
      seekTimer.current = window.setTimeout(() => {
        void commitSeek(index, restamp, gen);
      }, 50) as unknown as number;
      return;
    }
    void commitSeek(index, restamp, gen);
  };

  const flushSeek = () => {
    window.clearTimeout(seekTimer.current);
    const index = useCompareStore.getState().sequence.playhead;
    if (index === null) return;
    const gen = seekGen.current;
    void commitSeek(index, false, gen);
  };

  useEffect(
    () => () => {
      window.clearTimeout(seekTimer.current);
      seekGen.current += 1;
    },
    [],
  );

  const enterSequence = () => {
    const index = locateQuery.data?.index ?? 0;
    const name = locateQuery.data?.name ?? null;
    setSequence({
      engaged: true,
      playing: false,
      playhead: index,
      playPath: path,
      playName: name,
      playVersion: locateQuery.data ? versionOf(locateQuery.data) : "",
    });
  };

  const playOrPause = () => {
    const current = useCompareStore.getState().sequence;
    if (!rangeReady(current.start, current.end)) return;
    if (current.playing) {
      setSequence({ playing: false });
      return;
    }
    const atEnd = current.playhead !== null && current.playhead >= current.end!;
    const nextHead =
      !current.engaged ||
      current.playhead === null ||
      current.playhead < current.start! ||
      current.playhead > current.end! ||
      atEnd
        ? current.start!
        : current.playhead;
    seekTo(nextHead, true, { restamp: true });
  };

  const stepPlayhead = (delta: number) => {
    const current = useCompareStore.getState().sequence;
    if (!current.engaged || current.playing || !rangeReady(current.start, current.end)) return;
    const from = current.playhead ?? current.start!;
    const next = Math.min(current.end!, Math.max(current.start!, from + delta));
    if (next === from) return;
    seekTo(next, false);
  };

  useHotkeys(
    {
      p: () => {
        if (rangeReady(sequence.start, sequence.end)) playOrPause();
      },
      P: () => {
        if (rangeReady(sequence.start, sequence.end)) playOrPause();
      },
      ...(sequence.engaged
        ? {
            ArrowLeft: () => stepPlayhead(-1),
            ArrowRight: () => stepPlayhead(1),
          }
        : {}),
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
      data-engaged={sequence.engaged ? "true" : "false"}
      className={`flex h-8 shrink-0 items-center gap-2 border-t px-3 text-[11px] ${
        sequence.engaged
          ? "border-cyan-800 bg-cyan-950/40 text-zinc-300"
          : "border-zinc-800 bg-zinc-900/80 text-zinc-400"
      }`}
    >
      <IconButton
        title={sequence.engaged ? "退出序列（对比跟随文件列表）" : "进入序列（对比跟随 playhead）"}
        data-testid="sequence-engage"
        active={sequence.engaged}
        onClick={() => {
          if (sequence.engaged) exitSequence();
          else enterSequence();
        }}
      >
        <Film size={13} />
      </IconButton>
      <span className="shrink-0 font-medium" data-testid="sequence-source">
        {sequence.engaged ? "序列" : "列表"}
      </span>

      <IconButton
        title={sequence.playing ? "暂停（P）" : "播放（P）"}
        data-testid="sequence-play"
        disabled={!rangeReady(sequence.start, sequence.end)}
        active={sequence.playing}
        onClick={playOrPause}
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
        disabled={!rangeReady(sequence.start, sequence.end)}
        min={sequence.start ?? 0}
        max={sequence.end ?? 0}
        value={sequence.playhead ?? sequence.start ?? 0}
        onChange={(event) => seekTo(Number(event.target.value), false, { defer: true })}
        onPointerUp={flushSeek}
        onPointerCancel={flushSeek}
        className="h-1 min-w-16 flex-1 accent-cyan-500"
      />

      <span data-testid="sequence-playhead" className="shrink-0 font-mono text-zinc-500 tabular-nums">
        {sequence.engaged
          ? (sequence.playName ?? playName.data?.name ?? locateQuery.data?.name ?? "—")
          : (locateQuery.data?.name ?? "—")}{" "}
        · {(sequence.engaged ? (sequence.playhead ?? currentIndex) : currentIndex) + 1}/
        {total || "—"}
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
        disabled={!sequence.engaged || sequence.playhead === null || !(sequence.playPath || playName.data)}
        onClick={() => {
          const file = sequence.playPath
            ? { path: sequence.playPath, index: sequence.playhead! }
            : playName.data;
          if (file) jumpToFile(file.path, file.index);
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
          cells={exportCells}
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
