import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plug, Power, Server, Trash2 } from "lucide-react";
import { hub, type HubServer, type HubState, type NewServer } from "../../lib/hub";
import { Button, ErrorBox, Modal, Spinner, TextInput } from "../ui";

const STATE_META: Record<HubServer["state"], { dot: string; label: string }> = {
  idle: { dot: "bg-zinc-600", label: "未连接" },
  connecting: { dot: "bg-amber-400 animate-pulse", label: "连接中" },
  active: { dot: "bg-emerald-500", label: "已连接" },
  error: { dot: "bg-red-500", label: "出错" },
};

const EMPTY_FORM: NewServer = {
  name: "",
  host: "",
  user: "",
  port: 22,
  remoteDir: "~/npz-viewer",
  remotePort: 8756,
};

function Dot({ className }: { className: string }) {
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${className}`} />;
}

export function ServersDialog({
  onClose,
  onSwitched,
}: {
  onClose: () => void;
  onSwitched: () => void;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["hub-state"],
    queryFn: hub.state,
    refetchInterval: 2500,
  });
  const [form, setForm] = useState<NewServer>(EMPTY_FORM);

  const apply = (next: HubState) => queryClient.setQueryData(["hub-state"], next);

  const add = useMutation({
    mutationFn: () => hub.add(form),
    onSuccess: (next) => {
      apply(next);
      setForm(EMPTY_FORM);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => hub.remove(id),
    onSuccess: apply,
  });
  const connect = useMutation({
    mutationFn: (id: string) => hub.connect(id),
    onSuccess: (next) => {
      apply(next);
      onSwitched();
    },
  });
  const disconnect = useMutation({
    mutationFn: (id: string) => hub.disconnect(id),
    onSuccess: (next) => {
      apply(next);
      onSwitched();
    },
  });
  const setActive = useMutation({
    mutationFn: (target: string) => hub.setActive(target),
    onSuccess: (next) => {
      apply(next);
      onSwitched();
    },
  });

  const state = data;
  const servers = state?.servers ?? [];
  const busyId = connect.isPending
    ? connect.variables
    : disconnect.isPending
      ? disconnect.variables
      : undefined;

  const canSubmit = form.host.trim() && form.user.trim();

  return (
    <Modal title="后端服务器" onClose={onClose} width="max-w-3xl">
      <div className="space-y-4">
        <p className="text-xs text-zinc-500">
          前端始终在本机运行，数据请求 <code className="text-zinc-400">/api</code>{" "}
          会被转发到<b className="text-zinc-300">当前后端</b>。选择一台服务器会通过 SSH 把后端
          rsync 过去、在远端启动（有 tmux 用 tmux，否则用 nohup），再建立隧道——原始 npz 不过网，
          只有渲染好的图和 JSON 回传。需要免密 SSH（ssh-agent 或密钥）。
        </p>

        <div className="overflow-hidden rounded border border-zinc-800">
          {/* Local backend row */}
          <div className="flex items-center gap-3 border-b border-zinc-800 px-3 py-2">
            <Dot className={state?.localActive ? "bg-emerald-500" : "bg-zinc-600"} />
            <div className="min-w-0 flex-1">
              <div className="text-xs text-zinc-200">本机后端</div>
              <div className="truncate font-mono text-[11px] text-zinc-500">127.0.0.1:8756</div>
            </div>
            {state?.localActive ? (
              <span className="flex items-center gap-1 rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-400">
                <Check size={11} /> 当前
              </span>
            ) : (
              <Button onClick={() => setActive.mutate("local")} disabled={setActive.isPending}>
                使用
              </Button>
            )}
          </div>

          {isLoading && (
            <div className="flex items-center gap-2 p-3 text-xs text-zinc-500">
              <Spinner /> 加载中
            </div>
          )}
          {!isLoading && servers.length === 0 && (
            <div className="p-3 text-xs text-zinc-600">还没有添加远程服务器。</div>
          )}

          {servers.map((server) => {
            const meta = STATE_META[server.state];
            const isBusy = busyId === server.id;
            const connected = server.state === "active";
            return (
              <div key={server.id} className="border-b border-zinc-800 px-3 py-2 last:border-b-0">
                <div className="flex items-center gap-3">
                  <Dot className={meta.dot} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-xs text-zinc-200">{server.name}</span>
                      {server.active && (
                        <span className="flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-400">
                          <Check size={10} /> 当前
                        </span>
                      )}
                      <span className="text-[10px] text-zinc-500">{meta.label}</span>
                    </div>
                    <div className="truncate font-mono text-[11px] text-zinc-500">
                      {server.user}@{server.host}:{server.port} · {server.remoteDir} → :
                      {server.remotePort}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {isBusy && <Spinner className="mr-1" />}
                    {connected && !server.active && (
                      <Button onClick={() => setActive.mutate(server.id)} title="切到该后端">
                        使用
                      </Button>
                    )}
                    {connected ? (
                      <Button
                        variant="danger"
                        onClick={() => disconnect.mutate(server.id)}
                        disabled={isBusy}
                        title="停止远端后端并断开隧道"
                      >
                        <Power size={13} /> 停止
                      </Button>
                    ) : (
                      <Button
                        variant="solid"
                        onClick={() => connect.mutate(server.id)}
                        disabled={isBusy || server.state === "connecting"}
                        title="部署并连接"
                      >
                        <Plug size={13} /> {server.state === "error" ? "重试" : "连接"}
                      </Button>
                    )}
                    <Button
                      variant="danger"
                      onClick={() => remove.mutate(server.id)}
                      disabled={connected || server.state === "connecting"}
                      title="删除"
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </div>

                {server.state === "error" && server.error && (
                  <div className="mt-1.5 pl-5">
                    <ErrorBox error={new Error(server.error)} compact />
                    {server.log.length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-[10px] text-zinc-500 hover:text-zinc-300">
                          查看日志
                        </summary>
                        <pre className="mt-1 max-h-40 overflow-auto rounded bg-zinc-950 p-2 font-mono text-[10px] leading-relaxed text-zinc-400">
                          {server.log.join("\n")}
                        </pre>
                      </details>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Add-server form */}
        <div className="rounded border border-zinc-800 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-zinc-400 uppercase">
            <Server size={12} /> 添加服务器
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-zinc-500">显示名（可留空）</span>
              <TextInput
                value={form.name}
                placeholder="GPU1"
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-zinc-500">用户名</span>
              <TextInput
                value={form.user}
                placeholder="ubuntu"
                onChange={(event) => setForm({ ...form, user: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-zinc-500">主机</span>
              <TextInput
                value={form.host}
                placeholder="10.0.0.5 或 host.example.com"
                onChange={(event) => setForm({ ...form, host: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-zinc-500">SSH 端口</span>
              <TextInput
                type="number"
                value={form.port}
                onChange={(event) => setForm({ ...form, port: Number(event.target.value) })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-zinc-500">远端目录</span>
              <TextInput
                className="font-mono"
                value={form.remoteDir}
                onChange={(event) => setForm({ ...form, remoteDir: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-zinc-500">后端端口</span>
              <TextInput
                type="number"
                value={form.remotePort}
                onChange={(event) => setForm({ ...form, remotePort: Number(event.target.value) })}
              />
            </label>
          </div>
          <div className="mt-2 flex justify-end">
            <Button
              variant="solid"
              disabled={!canSubmit || add.isPending}
              onClick={() => add.mutate()}
            >
              添加
            </Button>
          </div>
        </div>

        {add.error && <ErrorBox error={add.error} compact />}
        {connect.error && <ErrorBox error={connect.error} compact />}
        {setActive.error && <ErrorBox error={setActive.error} compact />}
      </div>
    </Modal>
  );
}
