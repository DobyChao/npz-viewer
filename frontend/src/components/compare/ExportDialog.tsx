import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { dirname } from "../../lib/format";
import type { CompareLayout, Gamut, VideoCrop, VideoExportKey, VideoExportRequest } from "../../lib/types";
import { DEFAULT_VIEW_OPTIONS } from "../../lib/types";
import type { Viewport } from "../../store/useCompareStore";
import { Button, Checkbox, ErrorBox, Modal, Segmented, Select, Spinner } from "../ui";

const SIZE_OPTIONS = [
  { value: "1080", label: "1080p" },
  { value: "1920", label: "1920p" },
  { value: "2160", label: "4K" },
] as const;

const SOFT_LIMIT = 2000;

export function ExportDialog({
  path,
  keys,
  cells,
  start,
  end,
  fps,
  layout,
  gamut,
  equalHeight,
  viewport,
  tileSize,
  naturalSizes,
  onClose,
}: {
  path: string;
  keys: string[];
  cells?: VideoExportKey[];
  start: number;
  end: number;
  fps: number;
  layout: CompareLayout;
  gamut: Gamut;
  equalHeight: boolean;
  viewport: Viewport;
  tileSize: { width: number; height: number };
  naturalSizes: { width: number; height: number }[];
  onClose: () => void;
}) {
  const [crop, setCrop] = useState<VideoCrop>("full");
  const [maxSize, setMaxSize] = useState("1920");
  const [exportFps, setExportFps] = useState(String(fps));
  const [saveDir, setSaveDir] = useState(dirname(path));
  const [confirmLarge, setConfirmLarge] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const [copied, setCopied] = useState(false);

  const frameCount = end - start + 1;
  const needsConfirm = frameCount > SOFT_LIMIT;
  const viewportOk = tileSize.width >= 8 && tileSize.height >= 8;
  const busy = Boolean(jobId);

  const jobQuery = useQuery({
    queryKey: ["video-job", jobId],
    queryFn: () => api.videoJob(jobId!),
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "done" || status === "error" || status === "cancelled") return false;
      return 400;
    },
  });

  const job = jobQuery.data;
  const jobError =
    job?.status === "error" && job.error
      ? new Error(job.error)
      : jobQuery.error instanceof Error
        ? jobQuery.error
        : null;
  const done = job?.status === "done";

  const startExport = () => {
    setSubmitError(null);
    setCopied(false);
    const parsedFps = Number(exportFps);
    const body: VideoExportRequest = {
      path,
      keys:
        cells ??
        keys.map((key) => ({
          key,
          batch: DEFAULT_VIEW_OPTIONS.batch,
          layout: "auto",
          channel: DEFAULT_VIEW_OPTIONS.channel,
          normalize: DEFAULT_VIEW_OPTIONS.normalize,
          colormap: DEFAULT_VIEW_OPTIONS.colormap,
          alpha: DEFAULT_VIEW_OPTIONS.alpha,
          gainmap_gamut: DEFAULT_VIEW_OPTIONS.gainmapGamut,
        })),
      start,
      end,
      fps: Number.isFinite(parsedFps) ? parsedFps : fps,
      layout,
      crop,
      max_size: Number(maxSize),
      equal_height: equalHeight,
      confirm_large: confirmLarge,
      gamut,
      save_dir: saveDir.trim() || dirname(path),
      viewport:
        crop === "viewport"
          ? {
              scale: viewport.scale,
              x: viewport.x,
              y: viewport.y,
              tile_width: tileSize.width,
              tile_height: tileSize.height,
              natural_sizes: naturalSizes,
            }
          : undefined,
    };
    void api
      .startVideoExport(body)
      .then((created) => setJobId(created.id))
      .catch((error: unknown) => {
        setSubmitError(error instanceof Error ? error : new Error(String(error)));
      });
  };

  return (
    <Modal title="导出对比视频" onClose={onClose} width="max-w-md">
      <div className="space-y-4 text-xs">
        <p className="text-zinc-400">
          {(cells ?? keys).map((cell) =>
            typeof cell === "string"
              ? cell
              : cell.type === "ratio"
                ? `${cell.key_num} ÷ ${cell.key_den}`
                : cell.key,
          ).join(" · ")}{" "}
          · {frameCount} 帧 · 宫格{" "}
          <span className="font-mono text-zinc-300">{layout}</span>
        </p>

        <label className="block">
          <span className="mb-1 block text-zinc-500">画面</span>
          <Segmented
            value={crop}
            onChange={setCrop}
            options={[
              { value: "full", label: "完整原图" },
              {
                value: "viewport",
                label: "当前视口",
                title: viewportOk ? "按对比面板当前缩放/平移裁剪" : "格子尺寸过小",
              },
            ]}
          />
        </label>
        {crop === "viewport" && !viewportOk && (
          <p className="text-amber-400">对比格子还没有尺寸，请先让面板显示出来再导出视口。</p>
        )}

        <label className="block">
          <span className="mb-1 block text-zinc-500">长边上限</span>
          <Select value={maxSize} options={[...SIZE_OPTIONS]} onChange={setMaxSize} />
        </label>

        <label className="block">
          <span className="mb-1 block text-zinc-500">帧率</span>
          <input
            type="number"
            min={1}
            max={60}
            value={exportFps}
            onChange={(event) => setExportFps(event.target.value)}
            className="w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-zinc-500">保存到目录（服务器路径）</span>
          <input
            data-testid="export-save-dir"
            value={saveDir}
            onChange={(event) => setSaveDir(event.target.value)}
            disabled={busy}
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-200"
          />
          <p className="mt-1 text-[10px] text-zinc-600">
            写成磁盘路径，不经过浏览器文件选择器。无界面环境也能写完。
          </p>
        </label>

        {needsConfirm && (
          <Checkbox
            checked={confirmLarge}
            onChange={setConfirmLarge}
            label={`确认导出 ${frameCount} 帧（超过 ${SOFT_LIMIT}）`}
          />
        )}

        {(submitError || jobError) && (
          <ErrorBox error={submitError ?? jobError} />
        )}

        {job && (job.status === "queued" || job.status === "running") && (
          <div className="flex items-center gap-2 text-zinc-400">
            <Spinner />
            编码 {job.current} / {job.total}
          </div>
        )}

        {done && (
          <div className="space-y-2 rounded border border-zinc-800 bg-zinc-950 p-2 text-zinc-300">
            <p>已写入</p>
            <p data-testid="export-saved-path" className="break-all font-mono text-[11px] text-cyan-300">
              {job.saved_path ?? job.filename}
            </p>
            <div className="flex flex-wrap gap-2">
              {job.saved_path && (
                <Button
                  onClick={() => {
                    void navigator.clipboard.writeText(job.saved_path!).then(() => {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    });
                  }}
                >
                  {copied ? "已复制" : "复制路径"}
                </Button>
              )}
              {jobId && (
                <a
                  href={api.videoFileUrl(jobId)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800"
                >
                  在浏览器中打开
                </a>
              )}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          {busy && job?.status !== "done" && job?.status !== "error" && job?.status !== "cancelled" ? (
            <Button
              onClick={() => {
                if (jobId) void api.cancelVideoJob(jobId);
              }}
            >
              取消编码
            </Button>
          ) : (
            <Button onClick={onClose}>关闭</Button>
          )}
          <Button
            variant="solid"
            disabled={
              busy || (crop === "viewport" && !viewportOk) || (needsConfirm && !confirmLarge)
            }
            onClick={startExport}
          >
            开始导出
          </Button>
        </div>
      </div>
    </Modal>
  );
}
