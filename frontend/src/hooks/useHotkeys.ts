import { useEffect, useRef } from "react";

export type HotkeyHandler = (event: KeyboardEvent) => void;

/** Modifier-aware binding id, e.g. `ArrowLeft`, `ctrl+0`, ` ` for space. */
export type HotkeyMap = Record<string, HotkeyHandler>;

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function bindingFor(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(event.key === " " ? "space" : event.key);
  return parts.join("+");
}

export function useHotkeys(map: HotkeyMap, enabled = true): void {
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const handler = mapRef.current[bindingFor(event)];
      if (!handler) return;
      event.preventDefault();
      handler(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
