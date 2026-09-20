import { opRenderUrl, renderUrl, versionOf } from "./api";
import { isImageReady, loadImage, mapPool } from "./imageCache";
import type { Gamut, ViewOptions } from "./types";

const DECODE_CONCURRENCY = 2;

export type SequenceOp = { id: string; left: string; right: string; gain?: number };

export function urlsFor(
  file: { path: string; mtime: number; size: number },
  keys: string[],
  gamut: Gamut,
  op: SequenceOp | null,
  optionsByKey?: Record<string, Partial<ViewOptions>>,
): string[] {
  const version = versionOf(file);
  const urls = keys.map((key) =>
    renderUrl({ path: file.path, key, gamut, version, options: optionsByKey?.[key] }),
  );
  if (op) {
    urls.push(
      opRenderUrl({
        op: op.id,
        left: { path: file.path, key: op.left, version },
        right: { path: file.path, key: op.right, version },
        gamut,
        version,
        gain: op.gain,
      }),
    );
  }
  return urls;
}

export async function ensureUrls(urls: string[]): Promise<void> {
  await mapPool(urls, DECODE_CONCURRENCY, async (url) => {
    await loadImage(url);
  });
}

export function frameReady(
  file: { path: string; mtime: number; size: number },
  keys: string[],
  gamut: Gamut,
  op: SequenceOp | null,
  optionsByKey?: Record<string, Partial<ViewOptions>>,
): boolean {
  return urlsFor(file, keys, gamut, op, optionsByKey).every(isImageReady);
}
