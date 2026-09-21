import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useT } from "../i18n";
import { useAppStore } from "../store/useAppStore";
import { useCompareStore } from "../store/useCompareStore";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { Checkbox, Modal, Select, TextInput } from "./ui";

const PAGE_SIZES = [25, 50, 100, 200] as const;

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { data } = useQuery({ queryKey: ["server-settings"], queryFn: api.settings });
  const thumbs = useAppStore((state) => state.thumbs);
  const setThumbs = useAppStore((state) => state.setThumbs);
  const list = useAppStore((state) => state.list);
  const setList = useAppStore((state) => state.setList);
  const showPixelReadout = useCompareStore((state) => state.showPixelReadout);
  const setShowPixelReadout = useCompareStore((state) => state.setShowPixelReadout);

  return (
    <Modal title={t("settings.title")} onClose={onClose}>
      <div className="space-y-5 text-xs">
        <section className="space-y-2">
          <h3 className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
            {t("settings.language")}
          </h3>
          <LanguageSwitcher />
        </section>

        <section className="space-y-2">
          <h3 className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
            {t("settings.thumbs")}
          </h3>
          <Checkbox
            checked={thumbs.enabled}
            onChange={(enabled) => setThumbs({ enabled })}
            label={t("settings.thumbsEnabled")}
          />
          <label className="block">
            <span className="mb-1 block text-zinc-500">{t("settings.thumbsPrefer")}</span>
            <TextInput
              className="w-full font-mono"
              value={thumbs.prefer}
              onChange={(event) => setThumbs({ prefer: event.target.value })}
              placeholder="rgb,output,result"
            />
          </label>
        </section>

        <section className="space-y-2">
          <h3 className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
            {t("settings.list")}
          </h3>
          <label className="flex items-center gap-2">
            <span className="text-zinc-500">{t("settings.pageSize")}</span>
            <Select
              value={String(list.pageSize)}
              options={PAGE_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
              onChange={(value) => setList({ pageSize: Number(value), page: 1 })}
            />
          </label>
        </section>

        <section className="space-y-2">
          <h3 className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
            {t("settings.compare")}
          </h3>
          <Checkbox
            checked={showPixelReadout}
            onChange={setShowPixelReadout}
            label={t("settings.pixelReadout")}
          />
        </section>

        <section className="space-y-1 border-t border-zinc-800 pt-4 text-[11px] text-zinc-500">
          <h3 className="font-medium tracking-wide text-zinc-500 uppercase">{t("settings.backend")}</h3>
          {data ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono">
              <dt>{t("settings.version")}</dt>
              <dd className="text-zinc-400">{data.version}</dd>
              <dt>roots.json</dt>
              <dd className="truncate text-zinc-400">{data.roots_file}</dd>
              <dt>{t("settings.cacheDir")}</dt>
              <dd className="truncate text-zinc-400">{data.cache_dir}</dd>
              <dt>{t("settings.smallMatrix")}</dt>
              <dd className="text-zinc-400">
                {data.small_matrix_max}×{data.small_matrix_max}
              </dd>
              <dt>allow_pickle</dt>
              <dd className="text-zinc-400">
                {data.allow_pickle ? t("settings.pickleOn") : t("settings.pickleOff")}
              </dd>
            </dl>
          ) : (
            <p>{t("settings.reading")}</p>
          )}
          <p className="pt-2 leading-relaxed">{t("settings.iccNote")}</p>
        </section>
      </div>
    </Modal>
  );
}
