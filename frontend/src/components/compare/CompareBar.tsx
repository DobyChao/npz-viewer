import { PanelBottomClose, PanelBottomOpen, Trash2, X } from "lucide-react";
import clsx from "clsx";
import { renderUrl } from "../../lib/api";
import { useCurrentNpz } from "../../hooks/useCurrentNpz";
import { useImageResource } from "../../hooks/useImageResource";
import { useAppStore } from "../../store/useAppStore";
import { MAX_COMPARE_ITEMS, useCompareStore } from "../../store/useCompareStore";
import type { CompareItem } from "../../store/useCompareStore";
import { useT } from "../../i18n";
import { Button, IconButton, Segmented } from "../ui";

function Chip({ item }: { item: CompareItem }) {
  const t = useT();
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
      <IconButton title={t("common.remove")} className="h-5 w-5" onClick={() => removeItem(item.id)}>
        <X size={11} />
      </IconButton>
    </div>
  );
}

export function CompareBar() {
  const t = useT();
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
  const renderableNames = new Set(renderableKeys.map((key) => key.name));
  const missingSelected = insideKeys.filter((name) => !renderableNames.has(name));
  const selectedCount = mode === "cross" ? items.length : insideKeys.length;

  return (
    <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/40 px-3 py-1.5">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[11px] tracking-wide text-zinc-500 uppercase">
          {t("compare.section")}
        </span>
        <Segmented
          value={mode}
          options={[
            { value: "cross", label: t("compare.cross"), title: t("compare.crossTitle") },
            { value: "inside", label: t("compare.inside"), title: t("compare.insideTitle") },
          ]}
          onChange={setMode}
        />

        <span className="shrink-0 text-[11px] text-zinc-600 tabular-nums">
          {selectedCount} / {MAX_COMPARE_ITEMS}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {mode === "cross" && items.length > 0 && (
            <Button onClick={clearItems} title={t("compare.clearList")}>
              <Trash2 size={13} /> {t("compare.clear")}
            </Button>
          )}
          {mode === "inside" && insideKeys.length > 0 && (
            <Button onClick={() => setInsideKeys([])} title={t("compare.clearKeys")}>
              <Trash2 size={13} /> {t("compare.clear")}
            </Button>
          )}
          <IconButton
            title={panel === "hidden" ? t("compare.showPanel") : t("compare.hidePanel")}
            data-testid="compare-panel-toggle"
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
              {t("compare.crossHint")}
            </span>
          ) : (
            items.map((item) => <Chip key={item.id} item={item} />)
          )}
        </div>
      )}

      {mode === "inside" && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {missingSelected.map((name) => (
            <button
              key={name}
              type="button"
              data-testid="inside-key-missing"
              data-key={name}
              onClick={() => toggleInsideKey(name)}
              title={t("compare.missingKey")}
              className="rounded border border-dashed border-amber-700/80 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[11px] text-amber-400 hover:border-amber-500 hover:bg-amber-500/20"
            >
              {name}
              <span className="ml-1 text-[10px] text-amber-600">×</span>
            </button>
          ))}
          {renderableKeys.length === 0 && missingSelected.length === 0 ? (
            <span className="text-[11px] text-zinc-600">{t("compare.noRenderable")}</span>
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
                  title={full ? t("compare.maxKeys", { n: MAX_COMPARE_ITEMS }) : key.name}
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
              {t("compare.keepSelection")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
