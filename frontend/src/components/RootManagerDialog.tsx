import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { useT } from "../i18n";
import { Button, ErrorBox, Modal, Spinner, TextInput } from "./ui";

export function RootManagerDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
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
    <Modal title={t("roots.title")} onClose={onClose} width="max-w-2xl">
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <p className="shrink-0 text-xs text-zinc-500">
          {t("roots.intro1")} <code className="text-zinc-400">roots.json</code>
          {t("roots.intro2")}
          <code className="text-zinc-400"> D:/data</code>
          {t("roots.intro3")}
          <code className="text-zinc-400"> /mnt/data</code>
          {t("roots.intro4")}
        </p>

        <div
          data-testid="root-list"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded border border-zinc-800"
        >
          {isLoading && (
            <div className="flex items-center gap-2 p-3 text-xs text-zinc-500">
              <Spinner /> {t("common.loading")}
            </div>
          )}
          {!isLoading && roots.length === 0 && (
            <div className="p-3 text-xs text-zinc-600">{t("roots.empty")}</div>
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
                  {t("roots.missing")}
                </span>
              )}
              <Button
                variant="danger"
                onClick={() => remove.mutate(root.id)}
                disabled={remove.isPending}
                title={t("common.remove")}
              >
                <Trash2 size={13} />
              </Button>
            </div>
          ))}
        </div>

        <div className="flex shrink-0 items-end gap-2">
          <label className="flex-1">
            <span className="mb-1 block text-[11px] text-zinc-500">{t("roots.displayName")}</span>
            <TextInput
              className="w-full"
              value={name}
              placeholder={t("roots.displayPlaceholder")}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="flex-[2]">
            <span className="mb-1 block text-[11px] text-zinc-500">{t("roots.absPath")}</span>
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
            <FolderPlus size={13} /> {t("common.add")}
          </Button>
        </div>

        {add.error && <ErrorBox error={add.error} compact />}
        {remove.error && <ErrorBox error={remove.error} compact />}
      </div>
    </Modal>
  );
}
