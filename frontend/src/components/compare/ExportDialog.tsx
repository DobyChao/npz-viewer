import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { CompareLayout, Gamut, VideoCrop, VideoExportRequest } from "../../lib/types";
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
  const [confirmLarge, setConfirmLarge] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const downloaded = useRef(false);

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

  useEffect(() => {
    if (job?.status !== "done" || !jobId || downloaded.current) return;
    downloaded.current = true;
    const link = document.createElement("a");
    link.href = api.videoFileUrl(jobId);
    link.download = job.filename ?? "compare.mp4";
    link.click();
    onClose();
  }, [job?.status, job?.filename, jobId, onClose]);

  const startExport = () => {
    setSubmitError(null);
    const parsedFps = Number(exportFps);
    const body: VideoExportRequest = {
      path,
      keys: keys.map((key) => ({
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
          {keys.join(" · ")} · {frameCount} 帧 · 宫格{" "}
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

        <div className="flex justify-end gap-2 pt-2">
          {busy && job?.status !== "done" ? (
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
