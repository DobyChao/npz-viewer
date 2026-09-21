export type Locale = "zh" | "en";

export function detectLocale(): Locale {
  if (typeof navigator === "undefined") return "zh";
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const lang of langs) {
    const lower = (lang ?? "").toLowerCase();
    if (lower.startsWith("zh")) return "zh";
    if (lower.startsWith("en")) return "en";
  }
  return "en";
}

export function htmlLang(locale: Locale): string {
  return locale === "zh" ? "zh-CN" : "en";
}

export function isLocale(value: unknown): value is Locale {
  return value === "zh" || value === "en";
}
