import { ApiError } from "./api";

/**
 * Shared decoded-image cache. Sequence playback prefetches into this so compare
 * tiles can swap frames without a second network round-trip or a loading flash.
 */
const MAX_ENTRIES = 128;

const ready = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
const order: string[] = [];
const retained = new Map<string, number>();

async function parseError(response: Response): Promise<Error> {
  try {
    const body = await response.json();
    const detail = body?.detail;
    if (detail && typeof detail === "object") {
      return new ApiError(response.status, detail.code, detail.message, detail.hint ?? null);
    }
  } catch {
    // fall through
  }
  return new ApiError(response.status, "HTTP_ERROR", `${response.status} ${response.statusText}`, null);
}

function evictIfNeeded(): void {
  let skipped = 0;
  while (ready.size > MAX_ENTRIES && order.length > 0 && skipped < order.length) {
    const oldest = order.shift();
    if (!oldest) break;
    if ((retained.get(oldest) ?? 0) > 0 || inflight.has(oldest) || !ready.has(oldest)) {
      if (ready.has(oldest)) {
        order.push(oldest);
        skipped += 1;
      }
      continue;
    }
    skipped = 0;
    const objectUrl = ready.get(oldest);
    ready.delete(oldest);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

export function peekImage(url: string): string | null {
  return ready.get(url) ?? null;
}

export function isImageReady(url: string): boolean {
  return ready.has(url);
}

export function retainImage(url: string): void {
  retained.set(url, (retained.get(url) ?? 0) + 1);
}

export function releaseImage(url: string): void {
  const current = retained.get(url) ?? 0;
  if (current <= 1) retained.delete(url);
  else retained.set(url, current - 1);
}

export function loadImage(url: string): Promise<string> {
  const hit = ready.get(url);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(url);
  if (pending) return pending;

  const promise = (async () => {
    const response = await fetch(url);
    if (!response.ok) throw await parseError(response);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = objectUrl;
      await image.decode();
    } catch {
      // Decode is best-effort; the object URL is still usable as img src.
    }
    ready.set(url, objectUrl);
    order.push(url);
    inflight.delete(url);
    evictIfNeeded();
    return objectUrl;
  })().catch((error) => {
    inflight.delete(url);
    throw error;
  });

  inflight.set(url, promise);
  return promise;
}

export async function mapPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  };
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, () => run()));
}
