import { create } from "zustand";
import { DEFAULT_VIEW_OPTIONS } from "../lib/types";
import { DEFAULT_OP_ID } from "../lib/ops";
import type {
  CompareLayout,
  CompareMode,
  ComparePanelState,
  ViewOptions,
} from "../lib/types";

export const MAX_COMPARE_ITEMS = 4;

/** Extra derived tile is allowed only when 2 or 3 source tiles are showing. */
export function canEnableOp(sourceCount: number): boolean {
  return sourceCount >= 2 && sourceCount < MAX_COMPARE_ITEMS;
}

export function clampOperand(index: number, sourceCount: number): number {
  if (sourceCount <= 0) return 0;
  return Math.min(Math.max(0, index), sourceCount - 1);
}

export interface CompareItem {
  id: string;
  npzPath: string;
  npzName: string;
  version: string;
  key: string;
  options: ViewOptions;
}

export interface Viewport {
  scale: number;
  x: number;
  y: number;
}

export const IDENTITY_VIEWPORT: Viewport = { scale: 1, x: 0, y: 0 };

export interface SequenceState {
  /** When true, compare tiles follow playhead; otherwise they follow the file list. */
  engaged: boolean;
  start: number | null;
  end: number | null;
  playhead: number | null;
  playPath: string | null;
  playName: string | null;
  playing: boolean;
  fps: number;
}

export const DEFAULT_SEQUENCE: SequenceState = {
  engaged: false,
  start: null,
  end: null,
  playhead: null,
  playPath: null,
  playName: null,
  playing: false,
  fps: 12,
};

function clearedSequence(fps: number): SequenceState {
  return { ...DEFAULT_SEQUENCE, fps };
}

interface CompareState {
  mode: CompareMode;
  items: CompareItem[];
  /** Key names selected in inside mode; deliberately survives switching npz. */
  insideKeys: string[];
  layout: CompareLayout;
  toggleIndex: number | null;
  /**
   * FastStone's "Overlay (Right on Left)". When true the overlay is locked on;
   * when false, hold X to overlay. Kept as flat fields so selectors stay
   * referentially stable.
   */
  overlayEnabled: boolean;
  /** Tile index whose image is painted over tile 1; never 0. */
  overlaySource: number;
  /**
   * True while X is held. XOR'd with overlayEnabled: hold X to overlay
   * (default), or lock overlay on and hold X to peek underneath.
   */
  overlayPeek: boolean;
  /**
   * Scale every tile so all images share the first one's display height. Without it,
   * comparing a full-res render against a half-res gainmap is meaningless. A display
   * preference, so it deliberately survives changing tiles.
   */
  equalHeight: boolean;
  /**
   * Temporary binary-op tile appended after the source tiles. Session-only;
   * not written back to the npz. Survives key changes so sequence playback
   * can keep recomputing the same pairing.
   */
  opEnabled: boolean;
  /** Operator id from BINARY_OPS; default div = tile 2 ÷ tile 1. */
  opId: string;
  /** 0-based source-tile index of the left operand. Default 1 (tile 2). */
  opLeft: number;
  /** 0-based source-tile index of the right operand. Default 0 (tile 1). */
  opRight: number;
  panel: ComparePanelState;
  /** Last split height of the compare pane, as a percentage of the right column. */
  splitComparePercent: number;
  viewport: Viewport;
  /** True while the viewport is still whatever "fit to window" produced. */
  viewportFitted: boolean;
  /** Bumped to ask the mounted panel to recompute a fit / 1:1 zoom. */
  fitToken: number;
  actualToken: number;
  showPixelReadout: boolean;
  sequence: SequenceState;

  setMode: (mode: CompareMode) => void;
  addItem: (item: Omit<CompareItem, "id">) => boolean;
  removeItem: (id: string) => void;
  clearItems: () => void;
  toggleInsideKey: (key: string) => void;
  setInsideKeys: (keys: string[]) => void;
  setLayout: (layout: CompareLayout) => void;
  setPanel: (panel: ComparePanelState) => void;
  setSplitComparePercent: (percent: number) => void;
  cyclePanel: () => void;
  setToggleIndex: (index: number | null) => void;
  advanceToggle: (count: number) => void;
  setOverlayEnabled: (enabled: boolean) => void;
  setOverlaySource: (index: number) => void;
  setOverlayPeek: (peek: boolean) => void;
  setEqualHeight: (value: boolean) => void;
  setOpEnabled: (enabled: boolean) => void;
  setOpId: (opId: string) => void;
  setOpLeft: (index: number) => void;
  setOpRight: (index: number) => void;
  swapOpOperands: () => void;
  toggleOp: () => void;
  setViewport: (viewport: Viewport, source?: "manual" | "fit") => void;
  requestFit: () => void;
  requestActualSize: () => void;
  setShowPixelReadout: (value: boolean) => void;
  setSequence: (patch: Partial<SequenceState>) => void;
  resetSequence: () => void;
  exitSequence: () => void;
  togglePlayback: () => void;
}

function itemId(npzPath: string, key: string): string {
  return `${npzPath}::${key}`;
}

function keepOp(sourceCount: number, enabled: boolean): boolean {
  return enabled && canEnableOp(sourceCount);
}

function clampPair(left: number, right: number, sourceCount: number) {
  // Keep the 2÷1 defaults while only one source tile exists; clamping here
  // would smash opLeft 1→0 and the pair would stay 1÷1 after the second tile.
  if (sourceCount < 2) return { opLeft: left, opRight: right };
  return {
    opLeft: clampOperand(left, sourceCount),
    opRight: clampOperand(right, sourceCount),
  };
}

/** Changing which tiles are on screen invalidates both the A/B cursor and the overlay pairing. */
const RESET_TILE_VIEWS = {
  toggleIndex: null,
  overlayEnabled: false,
  overlaySource: 1,
  overlayPeek: false,
} as const;

export const useCompareStore = create<CompareState>()((set, get) => ({
  mode: "cross",
  items: [],
  insideKeys: [],
  layout: "auto",
  toggleIndex: null,
  overlayEnabled: false,
  overlaySource: 1,
  overlayPeek: false,
  equalHeight: false,
  opEnabled: false,
  opId: DEFAULT_OP_ID,
  opLeft: 1,
  opRight: 0,
  panel: "hidden",
  splitComparePercent: 45,
  viewport: IDENTITY_VIEWPORT,
  viewportFitted: true,
  fitToken: 0,
  actualToken: 0,
  showPixelReadout: true,
  sequence: { ...DEFAULT_SEQUENCE },

  setMode: (mode) =>
    set((state) => ({
      mode,
      ...RESET_TILE_VIEWS,
      opEnabled: false,
      opId: DEFAULT_OP_ID,
      opLeft: 1,
      opRight: 0,
      sequence: clearedSequence(state.sequence.fps),
    })),

  addItem: (item) => {
    const { items } = get();
    const id = itemId(item.npzPath, item.key);
    if (items.some((existing) => existing.id === id)) return true;
    if (items.length >= MAX_COMPARE_ITEMS) return false;
    set({
      items: [...items, { ...item, id, options: { ...DEFAULT_VIEW_OPTIONS, ...item.options } }],
      panel: get().panel === "hidden" ? "split" : get().panel,
      opEnabled: keepOp(items.length + 1, get().opEnabled),
      ...clampPair(get().opLeft, get().opRight, items.length + 1),
    });
    return true;
  },

  removeItem: (id) =>
    set((state) => {
      const items = state.items.filter((item) => item.id !== id);
      return {
        items,
        ...RESET_TILE_VIEWS,
        opEnabled: keepOp(items.length, state.opEnabled),
        ...clampPair(state.opLeft, state.opRight, items.length),
      };
    }),

  clearItems: () =>
    set({ items: [], ...RESET_TILE_VIEWS, opEnabled: false, opLeft: 1, opRight: 0 }),

  toggleInsideKey: (key) =>
    set((state) => {
      const insideKeys = state.insideKeys.includes(key)
        ? state.insideKeys.filter((name) => name !== key)
        : state.insideKeys.length >= MAX_COMPARE_ITEMS
          ? state.insideKeys
          : [...state.insideKeys, key];
      return {
        insideKeys,
        ...RESET_TILE_VIEWS,
        opEnabled: keepOp(insideKeys.length, state.opEnabled),
        ...clampPair(state.opLeft, state.opRight, insideKeys.length),
        panel: state.panel === "hidden" ? "split" : state.panel,
        sequence: insideKeys.length === 0 ? clearedSequence(state.sequence.fps) : state.sequence,
      };
    }),

  setInsideKeys: (keys) =>
    set((state) => ({
      insideKeys: keys.slice(0, MAX_COMPARE_ITEMS),
      ...RESET_TILE_VIEWS,
      opEnabled: keepOp(Math.min(keys.length, MAX_COMPARE_ITEMS), state.opEnabled),
      ...clampPair(state.opLeft, state.opRight, Math.min(keys.length, MAX_COMPARE_ITEMS)),
      sequence: keys.length === 0 ? clearedSequence(state.sequence.fps) : state.sequence,
    })),
  setLayout: (layout) => set({ layout }),
  setPanel: (panel) =>
    set((state) => ({
      panel,
      sequence: panel === "hidden" ? clearedSequence(state.sequence.fps) : state.sequence,
    })),
  setSplitComparePercent: (percent) =>
    set({ splitComparePercent: Math.min(85, Math.max(15, percent)) }),
  cyclePanel: () =>
    set((state) => ({ panel: state.panel === "full" ? "split" : "full" })),
  // A/B collapses to one tile and overlay stacks two, so only one can be active.
  setToggleIndex: (index) =>
    set(index === null ? { toggleIndex: null } : { toggleIndex: index, overlayEnabled: false }),

  advanceToggle: (count) =>
    set((state) => {
      if (count === 0) return {};
      if (state.toggleIndex === null) return { toggleIndex: 0, overlayEnabled: false };
      return { toggleIndex: (state.toggleIndex + 1) % count };
    }),

  setOverlayEnabled: (enabled) =>
    set(enabled ? { overlayEnabled: true, toggleIndex: null } : { overlayEnabled: false, overlayPeek: false }),
  setOverlaySource: (index) => set({ overlaySource: Math.max(1, index) }),
  setOverlayPeek: (peek) => set({ overlayPeek: peek }),
  setEqualHeight: (value) => set({ equalHeight: value }),
  setOpEnabled: (enabled) => set({ opEnabled: enabled }),
  setOpId: (opId) => set({ opId }),
  setOpLeft: (index) =>
    set((state) => {
      const source = state.mode === "cross" ? state.items.length : state.insideKeys.length;
      return { opLeft: clampOperand(index, source) };
    }),
  setOpRight: (index) =>
    set((state) => {
      const source = state.mode === "cross" ? state.items.length : state.insideKeys.length;
      return { opRight: clampOperand(index, source) };
    }),
  swapOpOperands: () =>
    set((state) => ({ opLeft: state.opRight, opRight: state.opLeft })),
  toggleOp: () =>
    set((state) => {
      const source = state.mode === "cross" ? state.items.length : state.insideKeys.length;
      if (!canEnableOp(source)) return { opEnabled: false };
      return { opEnabled: !state.opEnabled };
    }),

  // Panning must not reset when flipping between A and B, so the viewport is group-level state.
  // Anything but an explicit fit counts as manual, which stops the panel from re-fitting
  // on resize and throwing away a zoom the user chose.
  setViewport: (viewport, source = "manual") =>
    set({ viewport, viewportFitted: source === "fit" }),
  requestFit: () => set((state) => ({ fitToken: state.fitToken + 1 })),
  requestActualSize: () => set((state) => ({ actualToken: state.actualToken + 1 })),
  setShowPixelReadout: (value) => set({ showPixelReadout: value }),
  setSequence: (patch) =>
    set((state) => ({ sequence: { ...state.sequence, ...patch } })),
  resetSequence: () =>
    set((state) => ({ sequence: clearedSequence(state.sequence.fps) })),
  exitSequence: () =>
    set((state) => ({
      sequence: {
        ...state.sequence,
        engaged: false,
        playing: false,
        playhead: null,
        playPath: null,
        playName: null,
      },
    })),
  togglePlayback: () =>
    set((state) => {
      const { start, end, playhead, playing } = state.sequence;
      if (start === null || end === null || start > end) return {};
      if (playing) return { sequence: { ...state.sequence, playing: false } };
      const atEnd = playhead !== null && playhead >= end;
      const nextHead =
        playhead === null || playhead < start || playhead > end || atEnd ? start : playhead;
      return {
        sequence: { ...state.sequence, engaged: true, playing: true, playhead: nextHead },
      };
    }),
}));
