import { useEffect, useRef, useState } from "react";
import { loadImage, peekImage, releaseImage, retainImage } from "../lib/imageCache";

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
 * Sequence playback prefetches into {@link loadImage}'s cache, so a tile can
 * swap to the next frame from memory. The previous bitmap stays on screen until
 * the next one is actually ready — no spinner overlay.
 */
export function useImageResource(url: string | null, options: ImageResourceOptions = {}) {
  const { enabled = true, lazy = false, gated = false } = options;
  const elementRef = useRef<HTMLDivElement | null>(null);
  const retainedUrl = useRef<string | null>(null);
  const [visible, setVisible] = useState(!lazy);
  const [src, setSrc] = useState<string | null>(() => (url ? peekImage(url) : null));
  const [state, setState] = useState<ImageState>(() =>
    url && peekImage(url) ? "ready" : "idle",
  );
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

    const show = (objectUrl: string) => {
      if (retainedUrl.current && retainedUrl.current !== url) {
        releaseImage(retainedUrl.current);
      }
      retainImage(url);
      retainedUrl.current = url;
      setSrc(objectUrl);
      setState("ready");
      setError(null);
    };

    const cached = peekImage(url);
    if (cached) {
      show(cached);
      return;
    }
    if (!retainedUrl.current) setState("loading");

    void (async () => {
      if (gated) release = await gate.acquire();
      if (cancelled) {
        release?.();
        return;
      }
      try {
        const objectUrl = await loadImage(url);
        if (cancelled) return;
        show(objectUrl);
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof Error ? caught : new Error(String(caught)));
        setState("error");
      } finally {
        release?.();
      }
    })();

    return () => {
      cancelled = true;
      release?.();
    };
  }, [visible, enabled, url, gated]);

  useEffect(
    () => () => {
      if (retainedUrl.current) releaseImage(retainedUrl.current);
    },
    [],
  );

  return { elementRef, src, state, error };
}
