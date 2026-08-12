import { ChevronLeft, ChevronRight } from "lucide-react";
import type {
  AlphaMode,
  Colormap,
  Gamut,
  KeyMeta,
  Layout,
  ViewOptions,
} from "../../lib/types";
import { Checkbox, IconButton, Segmented, Select } from "../ui";

const COLOR_KINDS = new Set(["rgb", "rgba", "gainmap"]);
const GRAY_KINDS = new Set(["gray", "stack"]);

function Stepper({
  label,
  value,
  count,
  onChange,
}: {
  label: string;
  value: number;
  count: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded border border-zinc-700 px-1">
      <span className="text-[10px] text-zinc-500">{label}</span>
      <IconButton
        title="上一个"
        className="h-5 w-5"
        disabled={value <= 0}
        onClick={() => onChange(value - 1)}
      >
        <ChevronLeft size={11} />
      </IconButton>
      <span className="min-w-9 text-center text-[11px] text-zinc-300 tabular-nums">
        {value + 1}/{count}
      </span>
      <IconButton
        title="下一个"
        className="h-5 w-5"
        disabled={value >= count - 1}
        onClick={() => onChange(value + 1)}
      >
        <ChevronRight size={11} />
      </IconButton>
    </div>
  );
}

export function KeyControls({
  meta,
  options,
  onChange,
}: {
  meta: KeyMeta;
  options: ViewOptions;
  onChange: (patch: Partial<ViewOptions>) => void;
}) {
  const isColor = COLOR_KINDS.has(meta.kind);
  const isGray = GRAY_KINDS.has(meta.kind) || (meta.kind === "gainmap" && meta.channels === 1);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {isColor && (
        <Segmented
          value={options.gamut ?? "auto"}
          options={[
            { value: "auto", label: "跟随", title: "使用顶栏的全局色域设置" },
            { value: "bt2020", label: "2020" },
            { value: "p3", label: "P3" },
          ]}
          onChange={(value) =>
            onChange({ gamut: value === "auto" ? undefined : (value as Gamut) })
          }
        />
      )}

      {meta.ambiguous && (
        <Segmented
          value={options.layout ?? "auto"}
          options={[
            { value: "auto", label: "自动" },
            { value: "chw", label: "CHW" },
            { value: "hwc", label: "HWC" },
          ]}
          onChange={(value) =>
            onChange({ layout: value === "auto" ? undefined : (value as Layout) })
          }
        />
      )}

      {meta.batch !== null && meta.batch > 0 && (
        <Stepper
          label="batch"
          value={options.batch}
          count={meta.batch}
          onChange={(batch) => onChange({ batch })}
        />
      )}

      {meta.kind === "stack" && meta.channels !== null && (
        <Stepper
          label="通道"
          value={options.channel}
          count={meta.channels}
          onChange={(channel) => onChange({ channel })}
        />
      )}

      {meta.kind === "rgba" && (
        <Select
          title="alpha 显示方式"
          value={options.alpha}
          options={[
            { value: "composite", label: "带透明" },
            { value: "rgb", label: "忽略 alpha" },
            { value: "alpha", label: "只看 alpha" },
          ]}
          onChange={(value) => onChange({ alpha: value as AlphaMode })}
        />
      )}

      {meta.kind === "gainmap" && (
        <Checkbox
          checked={options.gainmapGamut}
          onChange={(gainmapGamut) => onChange({ gainmapGamut })}
          label="对 gainmap 也做色域变换"
        />
      )}

      {isGray && meta.kind !== "gainmap" && (
        <>
          <Checkbox
            checked={options.normalize}
            onChange={(normalize) => onChange({ normalize })}
            label="min/max 归一化"
          />
          <Select
            title="伪彩色"
            value={options.colormap}
            options={[
              { value: "none", label: "灰度" },
              { value: "viridis", label: "viridis" },
              { value: "magma", label: "magma" },
              { value: "turbo", label: "turbo" },
            ]}
            onChange={(value) => onChange({ colormap: value as Colormap })}
          />
        </>
      )}
    </div>
  );
}
