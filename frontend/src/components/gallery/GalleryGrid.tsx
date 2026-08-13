import { useLayoutEffect, useRef } from "react";
import { useCurrentNpz } from "../../hooks/useCurrentNpz";
import { EmptyState, ErrorBox, SectionHeader, Spinner } from "../ui";
import { GalleryCard } from "./GalleryCard";

/** Survives compare-panel collapse (height 0) which some browsers clamp to scrollTop 0. */
let savedScrollTop = 0;

export function GalleryGrid() {
  const { path, meta, version, isLoading, error } = useCurrentNpz();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const restore = () => {
      if (el.clientHeight > 1) el.scrollTop = savedScrollTop;
    };
    restore();
    const onScroll = () => {
      if (el.clientHeight > 1) savedScrollTop = el.scrollTop;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(restore);
    observer.observe(el);
    return () => {
      if (el.clientHeight > 1) savedScrollTop = el.scrollTop;
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <SectionHeader title={meta ? `Gallery · ${meta.keys.length} 个 key` : "Gallery"}>
        {isLoading && <Spinner className="h-3 w-3" />}
      </SectionHeader>

      <div ref={scrollRef} data-testid="gallery-scroll" className="min-h-0 flex-1 overflow-auto p-3">
        {!path && <EmptyState>选择一个 npz 后，这里会逐 key 展示可视化结果</EmptyState>}
        {error ? <ErrorBox error={error} /> : null}
        {path && meta && meta.keys.length === 0 && <EmptyState>该 npz 没有任何 key</EmptyState>}
        {path && meta && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
            {meta.keys.map((key) => (
              <GalleryCard
                key={key.name}
                path={meta.path}
                npzName={meta.name}
                version={version}
                meta={key}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
