import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronDown, ChevronRight, Folder, FolderOpen, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import { invalidateAfterFsRefresh } from "../lib/refresh";
import { useAppStore } from "../store/useAppStore";
import { Checkbox, EmptyState, ErrorBox, IconButton, SectionHeader, Spinner, TextInput } from "./ui";

function isAncestorOf(candidate: string, target: string | null): boolean {
  if (!target) return false;
  const a = candidate.toLowerCase();
  const b = target.toLowerCase();
  return b === a || b.startsWith(`${a}/`);
}

function TreeNode({
  path,
  name,
  hasChildren,
  depth,
}: {
  path: string;
  name: string;
  hasChildren: boolean;
  depth: number;
}) {
  const currentDir = useAppStore((state) => state.currentDir);
  const setDir = useAppStore((state) => state.setDir);
  const onPathToSelection = isAncestorOf(path, currentDir);
  const [open, setOpen] = useState(onPathToSelection && hasChildren);

  // Re-expand ancestors (and folders that actually have children) when the
  // selection is restored from localStorage or moves via hotkeys. Leaf folders
  // stay collapsed — there is nothing to show underneath.
  useEffect(() => {
    if (onPathToSelection && hasChildren) setOpen(true);
  }, [onPathToSelection, hasChildren]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["dirs", path],
    queryFn: () => api.dirs(path),
    enabled: open,
  });

  const selected = currentDir?.toLowerCase() === path.toLowerCase();
  const childCount = data?.dirs.length ?? null;
  const expanded = open && (isLoading || childCount === null || childCount > 0);

  useEffect(() => {
    if (childCount === 0 && open) setOpen(false);
  }, [childCount, open]);

  return (
    <div>
      <div
        data-testid="tree-node"
        data-path={path}
        data-expanded={expanded ? "true" : "false"}
        data-has-children={hasChildren ? "true" : "false"}
        className={clsx(
          "group flex h-6 cursor-pointer items-center gap-1 rounded pr-2 text-xs",
          selected ? "bg-cyan-500/15 text-cyan-200" : "text-zinc-400 hover:bg-zinc-800/70",
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        onClick={() => {
          setDir(path);
          if (hasChildren) setOpen(true);
        }}
        title={path}
      >
        <button
          type="button"
          className="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-600 hover:text-zinc-300"
          onClick={(event) => {
            event.stopPropagation();
            if (!hasChildren) return;
            setOpen((value) => !value);
          }}
        >
          {hasChildren ? (
            expanded ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )
          ) : null}
        </button>
        {expanded ? (
          <FolderOpen size={13} className="shrink-0 text-amber-500/70" />
        ) : (
          <Folder size={13} className="shrink-0 text-amber-500/50" />
        )}
        <span className="truncate">{name}</span>
      </div>

      {expanded && (
        <div>
          {isLoading && (
            <div style={{ paddingLeft: `${depth * 12 + 24}px` }} className="py-1">
              <Spinner className="h-3 w-3" />
            </div>
          )}
          {error && (
            <div style={{ paddingLeft: `${depth * 12 + 20}px` }} className="py-1 pr-2">
              <ErrorBox error={error} compact />
            </div>
          )}
          {data?.dirs.map((child) => (
            <TreeNode
              key={child.path}
              path={child.path}
              name={child.name}
              hasChildren={child.has_children}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FolderTree() {
  const queryClient = useQueryClient();
  const rootId = useAppStore((state) => state.rootId);
  const currentDir = useAppStore((state) => state.currentDir);
  const autoOpen = useAppStore((state) => state.autoOpen);
  const setAutoOpen = useAppStore((state) => state.setAutoOpen);

  const { data: rootsData } = useQuery({ queryKey: ["roots"], queryFn: api.roots });
  const activeRoot = rootsData?.roots.find((root) => root.id === rootId) ?? null;

  const refresh = useMutation({
    mutationFn: () => api.refresh(currentDir ?? activeRoot?.path ?? ""),
    onSuccess: () => {
      invalidateAfterFsRefresh(queryClient);
    },
  });

  return (
    <div className="flex h-full flex-col bg-zinc-900/30">
      <SectionHeader title="文件夹">
        <IconButton
          title="刷新当前目录（R）"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          <RefreshCw size={13} className={refresh.isPending ? "animate-spin" : undefined} />
        </IconButton>
      </SectionHeader>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {activeRoot ? (
          <TreeNode
            path={activeRoot.path}
            name={activeRoot.name}
            hasChildren
            depth={0}
          />
        ) : (
          <EmptyState>请先在顶栏添加并选择一个 root</EmptyState>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-zinc-800 px-3 py-2">
        <Checkbox
          checked={autoOpen.enabled}
          onChange={(enabled) => setAutoOpen({ enabled })}
          label="切换文件夹时自动打开第"
        />
        <TextInput
          type="number"
          min={1}
          value={autoOpen.index}
          disabled={!autoOpen.enabled}
          onChange={(event) =>
            setAutoOpen({ index: Math.max(1, Number(event.target.value) || 1) })
          }
          className="w-14"
        />
        <span className="text-xs text-zinc-500">个</span>
      </div>
    </div>
  );
}
