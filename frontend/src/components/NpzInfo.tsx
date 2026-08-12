import { useQuery } from "@tanstack/react-query";
import { FileArchive } from "lucide-react";
import { api } from "../lib/api";
import { formatBytes, formatTime } from "../lib/format";
import { useCurrentNpz } from "../hooks/useCurrentNpz";
import { CopyButton, ErrorBox, Spinner } from "./ui";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <span className="shrink-0 text-[11px] text-zinc-600">{label}</span>
      <span className="truncate text-xs text-zinc-300 tabular-nums">{value}</span>
    </div>
  );
}

export function NpzInfo() {
  const { path, meta, isLoading, error } = useCurrentNpz();
  const { data: position } = useQuery({
    queryKey: ["npz-locate", path],
    queryFn: () => api.locate(path!),
    enabled: Boolean(path),
  });

  if (!path) {
    return (
      <div className="flex h-12 shrink-0 items-center border-b border-zinc-800 bg-zinc-900/40 px-3 text-xs text-zinc-600">
        在左侧选择一个 npz 文件
      </div>
    );
  }

  return (
    <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/40 px-3 py-2">
      {error ? <ErrorBox error={error} compact /> : null}
      {!error && (
        <div className="flex items-center gap-3">
          <FileArchive size={16} className="shrink-0 text-cyan-500/80" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-zinc-100">
                {meta?.name ?? "…"}
              </span>
              {isLoading && <Spinner className="h-3 w-3" />}
              {position && (
                <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400 tabular-nums">
                  {position.index + 1} / {position.total}
                </span>
              )}
              {meta?.compressed && (
                <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                  已压缩
                </span>
              )}
            </div>
            <div className="truncate font-mono text-[11px] text-zinc-600">{path}</div>
          </div>

          <div className="flex shrink-0 items-center gap-4">
            <Field label="大小" value={meta ? formatBytes(meta.size) : "—"} />
            <Field label="key" value={meta ? meta.keys.length : "—"} />
            <Field label="修改" value={meta ? formatTime(meta.mtime) : "—"} />
            <div className="flex items-center gap-1">
              <CopyButton value={meta?.name ?? ""} title="复制文件名">
                文件名
              </CopyButton>
              <CopyButton value={path} title="复制完整路径">
                路径
              </CopyButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
