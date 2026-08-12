import { PanelBottomClose, PanelBottomOpen, Trash2, X } from "lucide-react";
import clsx from "clsx";
import { renderUrl } from "../../lib/api";
import { useCurrentNpz } from "../../hooks/useCurrentNpz";
import { useImageResource } from "../../hooks/useImageResource";
import { useAppStore } from "../../store/useAppStore";
import { MAX_COMPARE_ITEMS, useCompareStore } from "../../store/useCompareStore";
import type { CompareItem } from "../../store/useCompareStore";
import type { CompareMode } from "../../lib/types";
import { Button, IconButton, Segmented } from "../ui";

const MODE_OPTIONS: { value: CompareMode; label: string; title: string }[] = [
  { value: "cross", label: "跨文件", title: "从任意 npz 的 gallery 卡片加入图片进行对比" },
  { value: "inside", label: "文件内", title: "勾选当前 npz 的 key，切换 npz 时保持勾选" },
];

function Chip({ item }: { item: CompareItem }) {
  const gamut = useAppStore((state) => state.gamut);
  const removeItem = useCompareStore((state) => state.removeItem);
  const { src } = useImageResource(
    renderUrl({
      path: item.npzPath,
      key: item.key,
      gamut,
      version: item.version,
      maxSize: 48,
      format: "webp",
      options: item.options,
    }),
    { gated: true },
  );

  return (
    <div className="flex shrink-0 items-center gap-1.5 rounded border border-zinc-700 bg-zinc-900 py-0.5 pr-0.5 pl-1">
      <div className="checkerboard h-6 w-6 shrink-0 overflow-hidden rounded-sm">
        {src && <img src={src} alt="" className="h-full w-full object-contain" />}
      </div>
      <div className="min-w-0 max-w-40">
        <div className="truncate font-mono text-[11px] text-zinc-300">{item.key}</div>
        <div className="truncate text-[10px] text-zinc-600">{item.npzName}</div>
      </div>
      <IconButton title="移除" className="h-5 w-5" onClick={() => removeItem(item.id)}>
        <X size={11} />
      </IconButton>
    </div>
  );
}

export function CompareBar() {
  const { meta } = useCurrentNpz();
  const mode = useCompareStore((state) => state.mode);
  const setMode = useCompareStore((state) => state.setMode);
  const items = useCompareStore((state) => state.items);
  const clearItems = useCompareStore((state) => state.clearItems);
  const insideKeys = useCompareStore((state) => state.insideKeys);
  const toggleInsideKey = useCompareStore((state) => state.toggleInsideKey);
  const setInsideKeys = useCompareStore((state) => state.setInsideKeys);
  const panel = useCompareStore((state) => state.panel);
  const setPanel = useCompareStore((state) => state.setPanel);

  const renderableKeys = (meta?.keys ?? []).filter((key) => key.renderable);
  const selectedCount = mode === "cross" ? items.length : insideKeys.length;

  return (
    <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/40 px-3 py-1.5">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[11px] tracking-wide text-zinc-500 uppercase">对比</span>
        <Segmented value={mode} options={MODE_OPTIONS} onChange={setMode} />

        <span className="shrink-0 text-[11px] text-zinc-600 tabular-nums">
          {selectedCount} / {MAX_COMPARE_ITEMS}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {mode === "cross" && items.length > 0 && (
            <Button onClick={clearItems} title="清空对比列表">
              <Trash2 size={13} /> 清空
            </Button>
          )}
          {mode === "inside" && insideKeys.length > 0 && (
            <Button onClick={() => setInsideKeys([])} title="取消全部勾选">
              <Trash2 size={13} /> 清空
            </Button>
          )}
          <IconButton
            title={panel === "hidden" ? "显示对比面板" : "隐藏对比面板"}
            active={panel !== "hidden"}
            onClick={() => setPanel(panel === "hidden" ? "split" : "hidden")}
          >
            {panel === "hidden" ? <PanelBottomOpen size={14} /> : <PanelBottomClose size={14} />}
          </IconButton>
        </div>
      </div>

      {mode === "cross" && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {items.length === 0 ? (
            <span className="text-[11px] text-zinc-600">
              在下方 gallery 卡片上点「对比」加入图片，最多 4 张，可以来自不同的 npz。
            </span>
          ) : (
            items.map((item) => <Chip key={item.id} item={item} />)
          )}
        </div>
      )}

      {mode === "inside" && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {renderableKeys.length === 0 ? (
            <span className="text-[11px] text-zinc-600">当前 npz 没有可渲染的 key。</span>
          ) : (
            renderableKeys.map((key) => {
              const checked = insideKeys.includes(key.name);
              const full = insideKeys.length >= MAX_COMPARE_ITEMS && !checked;
              return (
                <button
                  key={key.name}
                  type="button"
                  data-testid="inside-key"
                  data-key={key.name}
                  disabled={full}
                  onClick={() => toggleInsideKey(key.name)}
                  title={full ? `最多勾选 ${MAX_COMPARE_ITEMS} 个` : key.name}
                  className={clsx(
                    "rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors",
                    checked
                      ? "border-cyan-600 bg-cyan-500/15 text-cyan-300"
                      : "border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200",
                    full && "cursor-not-allowed opacity-40",
                  )}
                >
                  {key.name}
                </button>
              );
            })
          )}
          {insideKeys.length > 0 && (
            <span className="ml-2 self-center text-[11px] text-zinc-600">
              切换 npz 时会保持勾选，缺失的 key 用占位块显示
            </span>
          )}
        </div>
      )}
    </div>
  );
}
