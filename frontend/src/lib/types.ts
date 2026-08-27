export type KeyKind =
  | "rgb"
  | "rgba"
  | "gray"
  | "gainmap"
  | "stack"
  | "table"
  | "scalar"
  | "raw";

export type Layout = "chw" | "hwc";
export type Gamut = "bt2020" | "p3";
export type SortField = "name" | "mtime" | "size";
export type SortOrder = "asc" | "desc";
export type AlphaMode = "composite" | "rgb" | "alpha";
export type Colormap = "none" | "viridis" | "magma" | "turbo";
export type CompareMode = "cross" | "inside";
export type ComparePanelState = "hidden" | "split" | "full";
/** Rows × columns; "auto" derives the grid from how many tiles are showing. */
export type CompareLayout = "auto" | "1x1" | "1x2" | "2x1" | "1x3" | "3x1" | "2x2";
export type VideoCrop = "full" | "viewport";
export type VideoJobStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface RootInfo {
  id: string;
  name: string;
  path: string;
  exists: boolean;
}

export interface DirEntryInfo {
  name: string;
  path: string;
  has_children: boolean;
}

export interface DirListing {
  path: string;
  parent: string | null;
  dirs: DirEntryInfo[];
}

export interface NpzFileInfo {
  name: string;
  path: string;
  size: number;
  mtime: number;
}

export interface NpzListPage {
  dir: string;
  total: number;
  page: number;
  page_size: number;
  pages: number;
  items: NpzFileInfo[];
}

export interface KeyMeta {
  name: string;
  shape: number[];
  dtype: string;
  kind: KeyKind;
  layout: Layout | null;
  ambiguous: boolean;
  batch: number | null;
  channels: number | null;
  height: number | null;
  width: number | null;
  channel_axis: number | null;
  nbytes: number;
  renderable: boolean;
  note: string | null;
}

export interface NpzMeta {
  path: string;
  name: string;
  size: number;
  mtime: number;
  compressed: boolean;
  keys: KeyMeta[];
}

export interface ArrayStats {
  min: number | null;
  max: number | null;
  mean: number | null;
  std: number | null;
  p1: number | null;
  p99: number | null;
  nan_count: number;
  inf_count: number;
  count: number;
}

export interface KeyData {
  path: string;
  key: string;
  shape: number[];
  dtype: string;
  kind: KeyKind;
  values: unknown;
  truncated: boolean;
  stats: ArrayStats | null;
}

export interface PixelValue {
  x: number;
  y: number;
  values: (number | null)[];
}

export interface SiblingResult {
  path: string;
  name: string;
  index: number;
  total: number;
}

export interface VideoExportKey {
  key: string;
  batch: number;
  layout?: string;
  channel: number;
  normalize: boolean;
  colormap: string;
  alpha: string;
  gainmap_gamut: boolean;
}

export interface VideoExportRequest {
  path: string;
  keys: VideoExportKey[];
  start: number;
  end: number;
  fps: number;
  layout: CompareLayout;
  crop: VideoCrop;
  max_size: number;
  equal_height: boolean;
  confirm_large: boolean;
  gamut: Gamut;
  viewport?: {
    scale: number;
    x: number;
    y: number;
    tile_width: number;
    tile_height: number;
    natural_sizes: { width: number; height: number }[];
  };
}

export interface VideoJobInfo {
  id: string;
  status: VideoJobStatus;
  current: number;
  total: number;
  error: string | null;
  filename: string | null;
}

export interface ServerSettings {
  version: string;
  small_matrix_max: number;
  allow_pickle: boolean;
  embed_icc: boolean;
  cache_dir: string;
  roots_file: string;
}

/** Per-key display overrides owned by a gallery card or compare tile. */
export interface ViewOptions {
  gamut?: Gamut;
  layout?: Layout;
  batch: number;
  channel: number;
  normalize: boolean;
  colormap: Colormap;
  alpha: AlphaMode;
  gainmapGamut: boolean;
}

export const DEFAULT_VIEW_OPTIONS: ViewOptions = {
  batch: 0,
  channel: 0,
  normalize: false,
  colormap: "none",
  alpha: "composite",
  gainmapGamut: false,
};
