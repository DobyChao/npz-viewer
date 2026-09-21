import { useAppStore } from "../store/useAppStore";
import type { Locale } from "../i18n/locale";
import { Segmented } from "./ui";

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const locale = useAppStore((state) => state.locale);
  const setLocale = useAppStore((state) => state.setLocale);

  return (
    <div data-testid="locale-switch">
      <Segmented
        value={locale}
        options={[
          { value: "zh", label: compact ? "中" : "中文", title: "中文" },
          { value: "en", label: compact ? "EN" : "English", title: "English" },
        ]}
        onChange={(value) => setLocale(value as Locale)}
      />
    </div>
  );
}
