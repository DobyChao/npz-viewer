import type {
  ArrayStats,
  DirListing,
  Gamut,
  KeyData,
  NpzListPage,
  NpzMeta,
  PixelValue,
  RootInfo,
  ServerSettings,
  SiblingResult,
  SortField,
  SortOrder,
  VideoExportRequest,
  VideoJobInfo,
  ViewOptions,
} from "./types";

const BASE = "/api";

export class ApiError extends Error {
  readonly code: string;
  readonly hint: string | null;
  readonly status: number;

  constructor(status: number, code: string, message: string, hint: string | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

type Params = Record<string, string | number | boolean | null | undefined>;

function toQuery(params: Params): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = "HTTP_ERROR";
  let message = `${response.status} ${response.statusText}`;
  let hint: string | null = null;
  try {
    const body = await response.json();
    const detail = body?.detail;
    if (detail && typeof detail === "object") {
      code = detail.code ?? code;
      message = detail.message ?? message;
      hint = detail.hint ?? null;
    } else if (typeof detail === "string") {
      message = detail;
    }
  } catch {
    // Non-JSON error bodies keep the status-line message.
  }
  return new ApiError(response.status, code, message, hint);
}

async function request<T>(path: string, params: Params = {}, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}${toQuery(params)}`, init);
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(
    path,
    {},
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

export const api = {
  settings: () => request<ServerSettings>("/settings"),
  roots: () => request<{ roots: RootInfo[] }>("/roots"),
  addRoot: (name: string, path: string) => postJson<RootInfo>("/roots", { name, path }),
  removeRoot: (id: string) =>
    request<{ roots: RootInfo[] }>(`/roots/${encodeURIComponent(id)}`, {}, { method: "DELETE" }),

  dirs: (path: string, force = false) => request<DirListing>("/fs/dirs", { path, force }),
  refresh: (path: string) => postJson<{ path: string; cleared: boolean }>("/fs/refresh", { path }),

  list: (args: {
    dir: string;
    page: number;
    page_size: number;
    sort: SortField;
    order: SortOrder;
    q: string;
  }) => request<NpzListPage>("/npz/list", args),

  meta: (path: string) => request<NpzMeta>("/npz/meta", { path }),
  data: (path: string, key: string, batch?: number) =>
    request<KeyData>("/npz/data", { path, key, batch }),
  stats: (path: string, key: string, batch?: number) =>
    request<ArrayStats>("/npz/stats", { path, key, batch }),
  pixel: (path: string, key: string, x: number, y: number, batch = 0) =>
    request<PixelValue>("/npz/pixel", { path, key, x, y, batch }),

  sibling: (path: string, scope: "file" | "folder", direction: "next" | "prev") =>
    request<SiblingResult>("/nav/sibling", { path, scope, direction }),
  locate: (path: string) => request<SiblingResult>("/nav/locate", { path }),
  navAt: (path: string, index: number) => request<SiblingResult>("/nav/at", { path, index }),

  startVideoExport: (body: VideoExportRequest) => postJson<VideoJobInfo>("/video/export", body),
  videoJob: (id: string) => request<VideoJobInfo>(`/video/jobs/${encodeURIComponent(id)}`),
  cancelVideoJob: (id: string) =>
    request<VideoJobInfo>(`/video/jobs/${encodeURIComponent(id)}/cancel`, {}, { method: "POST" }),
  videoFileUrl: (id: string) => `${BASE}/video/jobs/${encodeURIComponent(id)}/file`,
};

/** Cache buster: render URLs are immutable, so they must change when the file does. */
export function versionOf(file: { mtime: number; size: number }): string {
  return `${Math.round(file.mtime * 1000)}_${file.size}`;
}

export interface RenderRequest {
  path: string;
  key: string;
  gamut: Gamut;
  version?: string;
  maxSize?: number;
  format?: "png" | "webp";
  options?: Partial<ViewOptions>;
}

export function renderUrl({
  path,
  key,
  gamut,
  version,
  maxSize,
  format,
  options,
}: RenderRequest): string {
  const params: Params = {
    path,
    key,
    gamut: options?.gamut ?? gamut,
    v: version,
  };
  if (options?.layout) params.layout = options.layout;
  if (options?.batch) params.batch = options.batch;
  if (options?.channel) params.channel = options.channel;
  if (options?.normalize) params.normalize = true;
  if (options?.colormap && options.colormap !== "none") params.colormap = options.colormap;
  if (options?.alpha && options.alpha !== "composite") params.alpha = options.alpha;
  if (options?.gainmapGamut) params.gainmap_gamut = true;
  if (maxSize) params.max_size = maxSize;
  if (format) params.format = format;
  return `${BASE}/npz/render${toQuery(params)}`;
}

export function thumbUrl(args: {
  path: string;
  version: string;
  prefer: string;
  size?: number;
  gamut: Gamut;
}): string {
  return `${BASE}/npz/thumb${toQuery({
    path: args.path,
    prefer: args.prefer,
    size: args.size ?? 192,
    gamut: args.gamut,
    v: args.version,
  })}`;
}
