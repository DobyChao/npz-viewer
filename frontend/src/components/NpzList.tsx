import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { ImageOff, Search } from "lucide-react";
import { api, thumbUrl, versionOf } from "../lib/api";
import { dirname, formatBytes, formatTime } from "../lib/format";
import { useImageResource } from "../hooks/useImageResource";
import { useAppStore } from "../store/useAppStore";
import type { NpzFileInfo, SortField, SortOrder } from "../lib/types";
import { Pagination } from "./Pagination";
import { CopyButton, EmptyState, ErrorBox, SectionHeader, Select, Spinner, TextInput } from "./ui";

const ROW_HEIGHT = 56;
const THUMB_SIZE = 96;

const SORT_OPTIONS: { value: `${SortField}:${SortOrder}`; label: string }[] = [
  { value: "name:asc", label: "名称 ↑" },
  { value: "name:desc", label: "名称 ↓" },
  { value: "mtime:desc", label: "修改时间 ↓" },
  { value: "mtime:asc", label: "修改时间 ↑" },
  { value: "size:desc", label: "大小 ↓" },
  { value: "size:asc", label: "大小 ↑" },
];

function Thumbnail({ item }: { item: NpzFileInfo }) {
  const thumbs = useAppStore((state) => state.thumbs);
  const gamut = useAppStore((state) => state.gamut);
  const url = thumbs.enabled
    ? thumbUrl({
        path: item.path,
        version: versionOf(item),
        prefer: thumbs.prefer,
        size: THUMB_SIZE,
        gamut,
      })
    : null;
  const { elementRef, src, state } = useImageResource(url, {
    enabled: thumbs.enabled,
    lazy: true,
    gated: true,
  });

  return (
    <div
      ref={elementRef}
      className="checkerboard flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded border border-zinc-800"
    >
      {src && <img src={src} alt="" className="h-full w-full object-contain" />}
      {!src && state === "loading" && <Spinner className="h-3 w-3" />}
      {!src && state === "error" && <ImageOff size={13} className="text-zinc-700" />}
    </div>
  );
}

function Row({ item, selected }: { item: NpzFileInfo; selected: boolean }) {
  const setNpz = useAppStore((state) => state.setNpz);
  return (
    <div
      data-testid="npz-row"
      data-path={item.path}
      data-selected={selected ? "true" : "false"}
      className={clsx(
        "group flex h-full cursor-pointer items-center gap-2 rounded px-2",
        selected ? "bg-cyan-500/15" : "hover:bg-zinc-800/60",
      )}
      onClick={() => setNpz(item.path)}
      title={item.path}
    >
      <Thumbnail item={item} />
      <div className="min-w-0 flex-1">
        <div
          className={clsx(
            "truncate text-xs",
            selected ? "text-cyan-200" : "text-zinc-300",
          )}
        >
          {item.name}
        </div>
        <div className="truncate text-[11px] text-zinc-600 tabular-nums">
          {formatBytes(item.size)} · {formatTime(item.mtime)}
        </div>
      </div>
      <CopyButton
        value={item.path}
        title="复制完整路径"
        className="opacity-0 group-hover:opacity-100"
      />
    </div>
  );
}

export function NpzList() {
  const currentDir = useAppStore((state) => state.currentDir);
  const currentNpz = useAppStore((state) => state.currentNpz);
  const setNpz = useAppStore((state) => state.setNpz);
  const list = useAppStore((state) => state.list);
  const setList = useAppStore((state) => state.setList);
  const autoOpen = useAppStore((state) => state.autoOpen);

  const [search, setSearch] = useState(list.q);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingAutoOpen = useRef<number | null>(null);

  useEffect(() => setSearch(list.q), [list.q]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (search !== list.q) setList({ q: search });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search, list.q, setList]);

  const { data, error, isFetching } = useQuery({
    queryKey: [
      "npz-list",
      currentDir,
      list.page,
      list.pageSize,
      list.sort,
      list.order,
      list.q,
    ],
    queryFn: () =>
      api.list({
        dir: currentDir!,
        page: list.page,
        page_size: list.pageSize,
        sort: list.sort,
        order: list.order,
        q: list.q,
      }),
    enabled: Boolean(currentDir),
    placeholderData: keepPreviousData,
  });

  const items = useMemo(() => data?.items ?? [], [data]);

  // "Auto-open the Nth npz" is folder-wide, so jump to the page that contains it first.
  useEffect(() => {
    if (!currentDir || !autoOpen.enabled) return;
    // Sibling-folder navigation already picked a file here; don't override it.
    if (currentNpz && dirname(currentNpz).toLowerCase() === currentDir.toLowerCase()) return;
    const target = Math.max(1, autoOpen.index);
    const page = Math.ceil(target / list.pageSize);
    pendingAutoOpen.current = (target - 1) % list.pageSize;
    setList({ page });
    // Deliberately excludes currentNpz: re-running on every selection would fight the user.
  }, [currentDir, autoOpen.enabled, autoOpen.index, list.pageSize, setList]);

  useEffect(() => {
    const offset = pendingAutoOpen.current;
    if (offset === null || items.length === 0) return;
    pendingAutoOpen.current = null;
    const target = items[Math.min(offset, items.length - 1)];
    if (target) setNpz(target.path);
  }, [items, setNpz]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  useEffect(() => {
    virtualizer.scrollToOffset(0);
  }, [list.page, list.q, currentDir, virtualizer]);

  return (
    <div className="flex h-full flex-col bg-zinc-900/30">
      <SectionHeader title={`npz 列表${isFetching ? " …" : ""}`}>
        <Select
          value={`${list.sort}:${list.order}`}
          options={SORT_OPTIONS}
          onChange={(value) => {
            const [sort, order] = value.split(":") as [SortField, SortOrder];
            setList({ sort, order });
          }}
          title="排序方式"
        />
      </SectionHeader>

      <div className="flex shrink-0 items-center gap-1.5 border-b border-zinc-800 px-2 py-1.5">
        <Search size={12} className="shrink-0 text-zinc-600" />
        <TextInput
          value={search}
          placeholder="按文件名过滤"
          onChange={(event) => setSearch(event.target.value)}
          className="w-full"
        />
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-1">
        {!currentDir && <EmptyState>请在上方选择一个文件夹</EmptyState>}
        {error && (
          <div className="p-2">
            <ErrorBox error={error} compact />
          </div>
        )}
        {currentDir && !error && items.length === 0 && (
          <EmptyState>{list.q ? "没有匹配的 npz" : "该文件夹下没有 npz"}</EmptyState>
        )}
        {items.length > 0 && (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = items[virtualRow.index];
              if (!item) return null;
              return (
                <div
                  key={item.path}
                  className="absolute top-0 left-0 w-full"
                  style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
                >
                  <Row item={item} selected={item.path === currentNpz} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Pagination
        page={data?.page ?? 1}
        pages={data?.pages ?? 1}
        total={data?.total ?? 0}
        onChange={(page) => setList({ page })}
      />
    </div>
  );
}
