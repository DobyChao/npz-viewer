import { useEffect, useRef } from "react";
import { versionOf } from "../lib/api";
import { isImageReady, releaseImage, retainImage } from "../lib/imageCache";
import { loadSibling } from "../lib/navCache";
import { ensureUrls, urlsFor, type SequenceOp } from "../lib/sequenceFrames";
import { useCompareStore } from "../store/useCompareStore";
import type { Gamut } from "../lib/types";

const PREFETCH = 12;

export function rangeReady(start: number | null, end: number | null): boolean {
  return start !== null && end !== null && start <= end;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function syncPins(previous: string[], next: string[]): string[] {
  const nextSet = new Set(next);
  const prevSet = new Set(previous);
  for (const url of previous) {
    if (!nextSet.has(url)) releaseImage(url);
  }
  for (const url of next) {
    if (!prevSet.has(url)) retainImage(url);
  }
  return next;
}

export function useSequencePlayback(args: {
  path: string | null;
  keys: string[];
  gamut: Gamut;
  enabled: boolean;
  op?: SequenceOp | null;
}): void {
  const playing = useCompareStore((state) => state.sequence.playing);
  const fps = useCompareStore((state) => state.sequence.fps);
  const start = useCompareStore((state) => state.sequence.start);
  const end = useCompareStore((state) => state.sequence.end);
  const keysKey = args.keys.join("\0");
  const keysRef = useRef(args.keys);
  keysRef.current = args.keys;
  const op = args.op ?? null;
  const opKey = op ? `${op.id}\0${op.left}\0${op.right}` : "";
  const opRef = useRef(op);
  opRef.current = op;

  // Prefetch the nearest missing frames only. Waiting on the whole window used
  // to stall the playhead whenever a far frame was slow.
  useEffect(() => {
    if (!args.enabled || !playing || !args.path || !rangeReady(start, end) || keysKey.length === 0) {
      return;
    }
    const anchor = args.path;
    const gamut = args.gamut;
    let cancelled = false;
    let pinned: string[] = [];

    const fill = async () => {
      while (!cancelled) {
        const sequence = useCompareStore.getState().sequence;
        if (!sequence.playing || !rangeReady(sequence.start, sequence.end)) return;
        const from = sequence.playhead ?? sequence.start!;
        const keys = keysRef.current;
        const last = Math.min(from + PREFETCH, sequence.end!);
        const windowUrls: string[] = [];
        let nearestMissing: string[] | null = null;
        for (let index = from; index <= last; index += 1) {
          if (cancelled) return;
          const file = await loadSibling(anchor, index);
          if (cancelled) return;
          const urls = urlsFor(file, keys, gamut, opRef.current);
          windowUrls.push(...urls);
          if (nearestMissing === null && !urls.every(isImageReady)) nearestMissing = urls;
        }
        pinned = syncPins(pinned, windowUrls);
        if (cancelled) return;
        if (nearestMissing) await ensureUrls(nearestMissing);
        else await sleep(50);
      }
    };

    void fill();
    return () => {
      cancelled = true;
      pinned = syncPins(pinned, []);
    };
  }, [args.enabled, args.path, args.gamut, keysKey, opKey, start, end, playing]);

  // Advance one playhead per painted frame. Cached frames used to resolve in the
  // same turn; React batched those updates and the UI jumped several files.
  useEffect(() => {
    if (!args.enabled || !playing || !args.path || !rangeReady(start, end)) return;
    const anchor = args.path;
    const gamut = args.gamut;
    const frameMs = 1000 / Math.max(1, fps);
    let stopped = false;
    let due = performance.now() + frameMs;

    const tick = async () => {
      const opening = useCompareStore.getState().sequence;
      const head = opening.playhead ?? opening.start!;
      try {
        const current = await loadSibling(anchor, head);
        if (stopped) return;
        useCompareStore.getState().setSequence({
          playhead: head,
          playPath: current.path,
          playName: current.name,
          playVersion: versionOf(current),
        });
        await nextPaint();
      } catch {
        useCompareStore.getState().setSequence({ playing: false });
        return;
      }

      while (!stopped) {
        const sequence = useCompareStore.getState().sequence;
        if (!sequence.playing || !rangeReady(sequence.start, sequence.end)) return;
        const current = sequence.playhead ?? sequence.start!;
        if (current >= sequence.end!) {
          useCompareStore.getState().setSequence({ playing: false, playhead: sequence.end });
          return;
        }
        const next = current + 1;
        try {
          const file = await loadSibling(anchor, next);
          const urls = urlsFor(file, keysRef.current, gamut, opRef.current);
          if (!urls.every(isImageReady)) await ensureUrls(urls);
          if (stopped) return;
          const wait = due - performance.now();
          if (wait > 0) await sleep(wait);
          if (stopped) return;
          const latest = useCompareStore.getState().sequence;
          if (!latest.playing) return;
          useCompareStore.getState().setSequence({
            playhead: next,
            playPath: file.path,
            playName: file.name,
            playVersion: versionOf(file),
          });
          await nextPaint();
          due += frameMs;
          if (due < performance.now()) due = performance.now() + frameMs;
        } catch {
          useCompareStore.getState().setSequence({ playing: false });
          return;
        }
      }
    };

    void tick();
    return () => {
      stopped = true;
    };
  }, [args.enabled, args.path, args.gamut, playing, fps, start, end, opKey]);
}
