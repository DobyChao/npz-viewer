import { useEffect, useRef } from "react";
import { api, renderUrl } from "../lib/api";
import { dirname } from "../lib/format";
import { isImageReady, loadImage, mapPool } from "../lib/imageCache";
import { useCompareStore } from "../store/useCompareStore";
import type { Gamut, SiblingResult } from "../lib/types";

const PREFETCH = 8;
const PREFETCH_CONCURRENCY = 4;
const NAV_CACHE_MAX = 256;

const navByDirIndex = new Map<string, SiblingResult>();
const navOrder: string[] = [];

export function rangeReady(start: number | null, end: number | null): boolean {
  return start !== null && end !== null && start <= end;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function urlsFor(filePath: string, keys: string[], gamut: Gamut): string[] {
  return keys.map((key) => renderUrl({ path: filePath, key, gamut }));
}

async function ensureUrls(urls: string[]): Promise<void> {
  await mapPool(urls, PREFETCH_CONCURRENCY, async (url) => {
    await loadImage(url);
  });
}

function navKey(anchor: string, index: number): string {
  return `${dirname(anchor)}\0${index}`;
}

async function fileAt(anchor: string, index: number): Promise<SiblingResult> {
  const key = navKey(anchor, index);
  const hit = navByDirIndex.get(key);
  if (hit) return hit;
  const file = await api.navAt(anchor, index);
  navByDirIndex.set(key, file);
  navOrder.push(key);
  while (navOrder.length > NAV_CACHE_MAX) {
    const oldest = navOrder.shift();
    if (oldest) navByDirIndex.delete(oldest);
  }
  return file;
}

export function useSequencePlayback(args: {
  path: string | null;
  keys: string[];
  gamut: Gamut;
  enabled: boolean;
}): void {
  const playing = useCompareStore((state) => state.sequence.playing);
  const fps = useCompareStore((state) => state.sequence.fps);
  const start = useCompareStore((state) => state.sequence.start);
  const end = useCompareStore((state) => state.sequence.end);
  const keysKey = args.keys.join("\0");
  const keysRef = useRef(args.keys);
  keysRef.current = args.keys;

  // Prefetch only while playing. A range-selected pause used to keep this
  // loop alive, hammering /nav/at every 80ms even after the user stopped.
  useEffect(() => {
    if (!args.enabled || !playing || !args.path || !rangeReady(start, end) || keysKey.length === 0) {
      return;
    }
    const anchor = args.path;
    const gamut = args.gamut;
    let cancelled = false;

    const fill = async () => {
      while (!cancelled) {
        const sequence = useCompareStore.getState().sequence;
        if (!sequence.playing || !rangeReady(sequence.start, sequence.end)) return;
        const from = sequence.playhead ?? sequence.start!;
        const keys = keysRef.current;
        const last = Math.min(from + PREFETCH, sequence.end!);
        const jobs: number[] = [];
        for (let index = from; index <= last; index += 1) jobs.push(index);
        await mapPool(jobs, PREFETCH_CONCURRENCY, async (index) => {
          if (cancelled) return;
          const file = await fileAt(anchor, index);
          if (cancelled) return;
          const urls = urlsFor(file.path, keys, gamut);
          if (urls.every(isImageReady)) return;
          await ensureUrls(urls);
        });
        if (cancelled) return;
        await sleep(80);
      }
    };

    void fill();
    return () => {
      cancelled = true;
    };
  }, [args.enabled, args.path, args.gamut, keysKey, start, end, playing]);

  // Advance only after the next frame's bitmaps are in the shared cache.
  // Slow renders drop effective fps instead of skipping or flashing a spinner.
  useEffect(() => {
    if (!args.enabled || !playing || !args.path || !rangeReady(start, end)) return;
    const anchor = args.path;
    const gamut = args.gamut;
    const frameMs = 1000 / Math.max(1, fps);
    let stopped = false;
    let due = performance.now() + frameMs;

    const tick = async () => {
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
          const file = await fileAt(anchor, next);
          const urls = urlsFor(file.path, keysRef.current, gamut);
          if (!urls.every(isImageReady)) await ensureUrls(urls);
        } catch {
          useCompareStore.getState().setSequence({ playing: false });
          return;
        }
        if (stopped) return;
        const wait = due - performance.now();
        if (wait > 0) await sleep(wait);
        if (stopped) return;
        const latest = useCompareStore.getState().sequence;
        if (!latest.playing) return;
        useCompareStore.getState().setSequence({ playhead: next });
        due += frameMs;
        if (due < performance.now() - frameMs) due = performance.now() + frameMs;
      }
    };

    void tick();
    return () => {
      stopped = true;
    };
  }, [args.enabled, args.path, args.gamut, playing, fps, start, end]);
}
