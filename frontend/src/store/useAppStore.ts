import { create } from "zustand";
import { persist } from "zustand/middleware";
import { dirname } from "../lib/format";
import type { Gamut, SortField, SortOrder, ViewOptions } from "../lib/types";

export interface LightboxTarget {
  path: string;
  version: string;
  key: string;
  options: ViewOptions;
}

interface ListPrefs {
  page: number;
  pageSize: number;
  sort: SortField;
  order: SortOrder;
  q: string;
}

interface AppState {
  rootId: string | null;
  currentDir: string | null;
  currentNpz: string | null;
  gamut: Gamut;
  /** Auto-select the Nth npz whenever a folder is opened. */
  autoOpen: { enabled: boolean; index: number };
  list: ListPrefs;
  thumbs: { enabled: boolean; prefer: string };
  lightbox: LightboxTarget | null;

  setRoot: (id: string | null, path: string | null) => void;
  setDir: (path: string) => void;
  setNpz: (path: string | null) => void;
  /** Select a file that may live in another folder, moving the list to its page. */
  jumpToFile: (path: string, index: number) => void;
  setGamut: (gamut: Gamut) => void;
  setAutoOpen: (patch: Partial<{ enabled: boolean; index: number }>) => void;
  setList: (patch: Partial<ListPrefs>) => void;
  setThumbs: (patch: Partial<{ enabled: boolean; prefer: string }>) => void;
  openLightbox: (target: LightboxTarget) => void;
  closeLightbox: () => void;
}

const DEFAULT_LIST: ListPrefs = {
  page: 1,
  pageSize: 50,
  sort: "name",
  order: "asc",
  q: "",
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      rootId: null,
      currentDir: null,
      currentNpz: null,
      gamut: "bt2020",
      autoOpen: { enabled: false, index: 1 },
      list: DEFAULT_LIST,
      thumbs: { enabled: true, prefer: "rgb,output,result,pred" },
      lightbox: null,

      setRoot: (id, path) =>
        set({ rootId: id, currentDir: path, currentNpz: null, list: { ...DEFAULT_LIST } }),
      setDir: (path) =>
        set((state) => ({
          currentDir: path,
          currentNpz: null,
          list: { ...state.list, page: 1, q: "" },
        })),
      setNpz: (path) => set({ currentNpz: path }),
      jumpToFile: (path, index) =>
        set((state) => ({
          currentDir: dirname(path),
          currentNpz: path,
          // Index is reported against the unfiltered listing, so drop any active filter.
          list: {
            ...state.list,
            q: "",
            page: Math.floor(index / state.list.pageSize) + 1,
          },
        })),
      setGamut: (gamut) => set({ gamut }),
      setAutoOpen: (patch) => set((state) => ({ autoOpen: { ...state.autoOpen, ...patch } })),
      setList: (patch) =>
        set((state) => ({
          // Any change other than an explicit page jump returns to the first page.
          list: { ...state.list, page: patch.page ?? 1, ...patch },
        })),
      setThumbs: (patch) => set((state) => ({ thumbs: { ...state.thumbs, ...patch } })),
      openLightbox: (target) => set({ lightbox: target }),
      closeLightbox: () => set({ lightbox: null }),
    }),
    {
      name: "npz-view.app",
      version: 1,
      partialize: (state) => ({
        rootId: state.rootId,
        currentDir: state.currentDir,
        gamut: state.gamut,
        autoOpen: state.autoOpen,
        thumbs: state.thumbs,
        list: { ...state.list, page: 1, q: "" },
      }),
    },
  ),
);
