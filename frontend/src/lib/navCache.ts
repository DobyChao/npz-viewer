import { api } from "./api";
import { dirname } from "./format";
import type { SiblingResult } from "./types";

const MAX_ENTRIES = 256;
const ready = new Map<string, SiblingResult>();
const order: string[] = [];

function cacheKey(anchor: string, index: number): string {
  return `${dirname(anchor)}\0${index}`;
}

export function peekSibling(anchor: string, index: number): SiblingResult | null {
  return ready.get(cacheKey(anchor, index)) ?? null;
}

export function clearNavCache(directory?: string): void {
  if (!directory) {
    ready.clear();
    order.length = 0;
    return;
  }
  const prefix = `${directory}\0`;
  for (const key of [...ready.keys()]) {
    if (key.startsWith(prefix)) ready.delete(key);
  }
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const key = order[index];
    if (key && !ready.has(key)) order.splice(index, 1);
  }
}

export async function loadSibling(anchor: string, index: number): Promise<SiblingResult> {
  const key = cacheKey(anchor, index);
  const hit = ready.get(key);
  if (hit) return hit;
  const file = await api.navAt(anchor, index);
  ready.set(key, file);
  order.push(key);
  while (order.length > MAX_ENTRIES) {
    const oldest = order.shift();
    if (oldest) ready.delete(oldest);
  }
  return file;
}
