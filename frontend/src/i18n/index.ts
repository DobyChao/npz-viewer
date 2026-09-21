import { useCallback } from "react";
import { useAppStore } from "../store/useAppStore";
import { en } from "./en";
import type { Locale } from "./locale";
import { zh, type MessageKey } from "./zh";

export type { Locale } from "./locale";
export { detectLocale, htmlLang, isLocale } from "./locale";
export type { MessageKey };

export type Translator = (key: MessageKey, vars?: Record<string, string | number>) => string;

const DICTS: Record<Locale, Record<MessageKey, string>> = { zh, en };

const NOTE_EXACT: Record<string, MessageKey> = {
  空数组: "note.empty",
  "通道轴有歧义，默认按 HWC 解释": "note.ambiguous",
  "多通道堆栈，逐通道显示": "note.stack",
  "非数值数据，按文本显示": "note.nonNumeric",
};

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

export function translate(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  return interpolate(DICTS[locale][key] ?? DICTS.zh[key], vars);
}

export function useT(): Translator {
  const locale = useAppStore((state) => state.locale);
  return useCallback((key, vars) => translate(locale, key, vars), [locale]);
}

export function translateNote(note: string | null | undefined, t: Translator): string | null {
  if (!note) return null;
  const exact = NOTE_EXACT[note];
  if (exact) return t(exact);
  const dim = /^(\d+) 维数组暂不支持可视化$/.exec(note);
  if (dim) return t("note.unsupportedDim", { n: dim[1] });
  return note;
}

export function opLabel(opId: string, t: Translator): string {
  if (opId === "mul") return t("op.mul");
  return t("op.div");
}
