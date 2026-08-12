import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, HardDrive, Settings, SlidersHorizontal } from "lucide-react";
import { api } from "../lib/api";
import { breadcrumbs } from "../lib/format";
import { useAppStore } from "../store/useAppStore";
import type { Gamut, RootInfo } from "../lib/types";
import { RootManagerDialog } from "./RootManagerDialog";
import { SettingsDialog } from "./SettingsDialog";
import { Button, IconButton, Segmented, Select } from "./ui";

const GAMUT_OPTIONS: { value: Gamut; label: string; title: string }[] = [
  { value: "bt2020", label: "BT.2020", title: "不做色域变换，直接 gamma 编码" },
  { value: "p3", label: "P3", title: "先做 BT.2020 → Display P3 矩阵变换再 gamma 编码" },
];

export function TopBar() {
  const { data } = useQuery({ queryKey: ["roots"], queryFn: api.roots });
  const rootId = useAppStore((state) => state.rootId);
  const currentDir = useAppStore((state) => state.currentDir);
  const gamut = useAppStore((state) => state.gamut);
  const setRoot = useAppStore((state) => state.setRoot);
  const setDir = useAppStore((state) => state.setDir);
  const setGamut = useAppStore((state) => state.setGamut);
  const [showRoots, setShowRoots] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const roots: RootInfo[] = data?.roots ?? [];
  const activeRoot = roots.find((root) => root.id === rootId) ?? null;

  // Fall back to the first root when nothing is chosen or the persisted one disappeared.
  useEffect(() => {
    if (roots.length === 0) return;
    if (activeRoot) return;
    const first = roots[0];
    setRoot(first.id, first.path);
  }, [roots, activeRoot, setRoot]);

  const crumbs =
    activeRoot && currentDir ? breadcrumbs(activeRoot.path, activeRoot.name, currentDir) : [];

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-900 px-3">
      <div className="flex items-center gap-1.5">
        <HardDrive size={15} className="text-cyan-500" />
        <span className="text-sm font-semibold tracking-tight text-zinc-100">npz 浏览器</span>
      </div>

      <div className="flex items-center gap-1">
        <Select
          title="选择 root"
          value={activeRoot?.id ?? ""}
          options={
            roots.length
              ? roots.map((root) => ({ value: root.id, label: root.name }))
              : [{ value: "", label: "未配置 root" }]
          }
          onChange={(value) => {
            const next = roots.find((root) => root.id === value);
            if (next) setRoot(next.id, next.path);
          }}
          className="max-w-44"
        />
        <IconButton title="管理 root" onClick={() => setShowRoots(true)}>
          <SlidersHorizontal size={14} />
        </IconButton>
      </div>

      <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-xs">
        {crumbs.map((crumb, index) => (
          <span key={crumb.path} className="flex shrink-0 items-center gap-0.5">
            {index > 0 && <ChevronRight size={12} className="text-zinc-700" />}
            <button
              type="button"
              onClick={() => setDir(crumb.path)}
              className={
                index === crumbs.length - 1
                  ? "rounded px-1 py-0.5 text-zinc-200"
                  : "rounded px-1 py-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
              }
            >
              {crumb.label}
            </button>
          </span>
        ))}
      </nav>

      <div className="flex shrink-0 items-center gap-2">
        <span className="text-[11px] text-zinc-500">显示色域</span>
        <Segmented value={gamut} options={GAMUT_OPTIONS} onChange={setGamut} />
        <IconButton title="设置" onClick={() => setShowSettings(true)}>
          <Settings size={14} />
        </IconButton>
      </div>

      {roots.length === 0 && (
        <Button variant="solid" onClick={() => setShowRoots(true)}>
          添加 root
        </Button>
      )}

      {showRoots && <RootManagerDialog onClose={() => setShowRoots(false)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
    </header>
  );
}
