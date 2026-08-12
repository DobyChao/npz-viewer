import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAppStore } from "../store/useAppStore";
import { useCompareStore } from "../store/useCompareStore";
import { Checkbox, Modal, Select, TextInput } from "./ui";

const PAGE_SIZES = [25, 50, 100, 200] as const;

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { data } = useQuery({ queryKey: ["server-settings"], queryFn: api.settings });
  const thumbs = useAppStore((state) => state.thumbs);
  const setThumbs = useAppStore((state) => state.setThumbs);
  const list = useAppStore((state) => state.list);
  const setList = useAppStore((state) => state.setList);
  const showPixelReadout = useCompareStore((state) => state.showPixelReadout);
  const setShowPixelReadout = useCompareStore((state) => state.setShowPixelReadout);

  return (
    <Modal title="设置" onClose={onClose}>
      <div className="space-y-5 text-xs">
        <section className="space-y-2">
          <h3 className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">缩略图</h3>
          <Checkbox
            checked={thumbs.enabled}
            onChange={(enabled) => setThumbs({ enabled })}
            label="在 npz 列表中显示缩略图"
          />
          <label className="block">
            <span className="mb-1 block text-zinc-500">
              优先使用的 key 名（逗号分隔，子串匹配；都找不到时自动挑第一张彩色图）
            </span>
            <TextInput
              className="w-full font-mono"
              value={thumbs.prefer}
              onChange={(event) => setThumbs({ prefer: event.target.value })}
              placeholder="rgb,output,result"
            />
          </label>
        </section>

        <section className="space-y-2">
          <h3 className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">列表</h3>
          <label className="flex items-center gap-2">
            <span className="text-zinc-500">每页条数</span>
            <Select
              value={String(list.pageSize)}
              options={PAGE_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
              onChange={(value) => setList({ pageSize: Number(value), page: 1 })}
            />
          </label>
        </section>

        <section className="space-y-2">
          <h3 className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">对比</h3>
          <Checkbox
            checked={showPixelReadout}
            onChange={setShowPixelReadout}
            label="悬停时读取原始像素值（会向后端发请求）"
          />
        </section>

        <section className="space-y-1 border-t border-zinc-800 pt-4 text-[11px] text-zinc-500">
          <h3 className="font-medium tracking-wide text-zinc-500 uppercase">后端</h3>
          {data ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono">
              <dt>版本</dt>
              <dd className="text-zinc-400">{data.version}</dd>
              <dt>roots.json</dt>
              <dd className="truncate text-zinc-400">{data.roots_file}</dd>
              <dt>缓存目录</dt>
              <dd className="truncate text-zinc-400">{data.cache_dir}</dd>
              <dt>小矩阵阈值</dt>
              <dd className="text-zinc-400">
                {data.small_matrix_max}×{data.small_matrix_max}
              </dd>
              <dt>allow_pickle</dt>
              <dd className="text-zinc-400">{data.allow_pickle ? "已开启" : "已关闭"}</dd>
            </dl>
          ) : (
            <p>读取中…</p>
          )}
          <p className="pt-2 leading-relaxed">
            渲染输出不嵌入 ICC profile，浏览器按 sRGB 解释像素值。选择 P3
            只做数值变换，因此在广色域屏上颜色是近似的。
          </p>
        </section>
      </div>
    </Modal>
  );
}
