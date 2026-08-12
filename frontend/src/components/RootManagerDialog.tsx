import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { Button, ErrorBox, Modal, Spinner, TextInput } from "./ui";

export function RootManagerDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["roots"], queryFn: api.roots });
  const [name, setName] = useState("");
  const [path, setPath] = useState("");

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["roots"] });

  const add = useMutation({
    mutationFn: () => api.addRoot(name, path),
    onSuccess: () => {
      setName("");
      setPath("");
      void invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.removeRoot(id),
    onSuccess: () => void invalidate(),
  });

  const roots = data?.roots ?? [];

  return (
    <Modal title="管理 root" onClose={onClose} width="max-w-2xl">
      <div className="space-y-4">
        <p className="text-xs text-zinc-500">
          root 保存在后端的 <code className="text-zinc-400">roots.json</code>
          ，也可以直接编辑该文件，后端会自动热加载。路径必须是绝对路径，Windows 形如
          <code className="text-zinc-400"> D:/data</code>，Linux 形如
          <code className="text-zinc-400"> /mnt/data</code>。
        </p>

        <div className="rounded border border-zinc-800">
          {isLoading && (
            <div className="flex items-center gap-2 p-3 text-xs text-zinc-500">
              <Spinner /> 加载中
            </div>
          )}
          {!isLoading && roots.length === 0 && (
            <div className="p-3 text-xs text-zinc-600">还没有配置任何 root。</div>
          )}
          {roots.map((root) => (
            <div
              key={root.id}
              className="flex items-center gap-3 border-b border-zinc-800 px-3 py-2 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-zinc-200">{root.name}</div>
                <div className="truncate font-mono text-[11px] text-zinc-500">{root.path}</div>
              </div>
              {!root.exists && (
                <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-400">
                  目录不存在
                </span>
              )}
              <Button
                variant="danger"
                onClick={() => remove.mutate(root.id)}
                disabled={remove.isPending}
                title="移除"
              >
                <Trash2 size={13} />
              </Button>
            </div>
          ))}
        </div>

        <div className="flex items-end gap-2">
          <label className="flex-1">
            <span className="mb-1 block text-[11px] text-zinc-500">显示名（可留空）</span>
            <TextInput
              className="w-full"
              value={name}
              placeholder="例如：实验结果"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="flex-[2]">
            <span className="mb-1 block text-[11px] text-zinc-500">绝对路径</span>
            <TextInput
              className="w-full font-mono"
              value={path}
              placeholder="D:/data/results"
              onChange={(event) => setPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && path.trim()) add.mutate();
              }}
            />
          </label>
          <Button
            variant="solid"
            className="h-[26px]"
            disabled={!path.trim() || add.isPending}
            onClick={() => add.mutate()}
          >
            <FolderPlus size={13} /> 添加
          </Button>
        </div>

        {add.error && <ErrorBox error={add.error} compact />}
        {remove.error && <ErrorBox error={remove.error} compact />}
      </div>
    </Modal>
  );
}
