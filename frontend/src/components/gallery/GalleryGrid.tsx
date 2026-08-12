import { useCurrentNpz } from "../../hooks/useCurrentNpz";
import { EmptyState, ErrorBox, SectionHeader, Spinner } from "../ui";
import { GalleryCard } from "./GalleryCard";

export function GalleryGrid() {
  const { path, meta, version, isLoading, error } = useCurrentNpz();

  return (
    <div className="flex h-full flex-col">
      <SectionHeader title={meta ? `Gallery · ${meta.keys.length} 个 key` : "Gallery"}>
        {isLoading && <Spinner className="h-3 w-3" />}
      </SectionHeader>

      <div className="min-h-0 flex-1 overflow-auto p-3">
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
