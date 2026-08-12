import { useEffect, useRef, useState } from "react";
import { ApiError } from "../lib/api";

const MAX_CONCURRENT_GATED = 4;

/** Global gate so scrolling a 200k-file list never floods the backend with decode work. */
class RequestGate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  async acquire(): Promise<() => void> {
    if (this.active >= MAX_CONCURRENT_GATED) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiting.shift()?.();
    };
  }
}

const gate = new RequestGate();

async function parseError(response: Response): Promise<Error> {
  try {
    const body = await response.json();
    const detail = body?.detail;
    if (detail && typeof detail === "object") {
      return new ApiError(response.status, detail.code, detail.message, detail.hint ?? null);
    }
  } catch {
    // fall through to the generic message
  }
  return new ApiError(response.status, "HTTP_ERROR", `${response.status} ${response.statusText}`, null);
}

export type ImageState = "idle" | "loading" | "ready" | "error";

export interface ImageResourceOptions {
  enabled?: boolean;
  /** Wait until the element scrolls into view before requesting. */
  lazy?: boolean;
  /** Queue behind the shared concurrency limit; use for list thumbnails. */
  gated?: boolean;
}

/**
 * Fetches a rendered image as a blob rather than binding the URL to `<img src>`.
 *
 * Going through `fetch` buys two things the plain element cannot give us:
 * in-flight cancellation when a row scrolls away, and the backend's structured
 * error payload instead of an opaque `onerror`.
 */
export function useImageResource(url: string | null, options: ImageResourceOptions = {}) {
  const { enabled = true, lazy = false, gated = false } = options;
  const elementRef = useRef<HTMLDivElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [visible, setVisible] = useState(!lazy);
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<ImageState>("idle");
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!lazy) return;
    const element = elementRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
      },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [lazy]);

  useEffect(() => {
    if (!visible || !enabled || !url) return;
    let cancelled = false;
    let release: (() => void) | null = null;
    const controller = new AbortController();
    setState("loading");
    setError(null);

    void (async () => {
      if (gated) release = await gate.acquire();
      if (cancelled) {
        release?.();
        return;
      }
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw await parseError(response);
        const blob = await response.blob();
        if (cancelled) return;
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = URL.createObjectURL(blob);
        setSrc(objectUrlRef.current);
        setState("ready");
      } catch (caught) {
        if (cancelled || (caught instanceof DOMException && caught.name === "AbortError")) return;
        setError(caught instanceof Error ? caught : new Error(String(caught)));
        setState("error");
      } finally {
        release?.();
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      release?.();
    };
  }, [visible, enabled, url, gated]);

  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    },
    [],
  );

  return { elementRef, src, state, error };
}
