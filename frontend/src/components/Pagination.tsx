import { useEffect, useState } from "react";
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from "lucide-react";
import { IconButton, TextInput } from "./ui";
import { useT } from "../i18n";

export function Pagination({
  page,
  pages,
  total,
  onChange,
}: {
  page: number;
  pages: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(String(page));

  useEffect(() => setDraft(String(page)), [page]);

  const commit = () => {
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) {
      onChange(Math.min(pages, Math.max(1, Math.round(parsed))));
    } else {
      setDraft(String(page));
    }
  };

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-t border-zinc-800 bg-zinc-900/60 px-2 text-[11px] text-zinc-500">
      <IconButton title={t("page.first")} disabled={page <= 1} onClick={() => onChange(1)}>
        <ChevronFirst size={13} />
      </IconButton>
      <IconButton title={t("page.prev")} disabled={page <= 1} onClick={() => onChange(page - 1)}>
        <ChevronLeft size={13} />
      </IconButton>

      <div className="flex items-center gap-1">
        <TextInput
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
          className="w-11 text-center"
        />
        <span>/ {pages}</span>
      </div>

      <IconButton title={t("page.next")} disabled={page >= pages} onClick={() => onChange(page + 1)}>
        <ChevronRight size={13} />
      </IconButton>
      <IconButton title={t("page.last")} disabled={page >= pages} onClick={() => onChange(pages)}>
        <ChevronLast size={13} />
      </IconButton>

      <span className="ml-auto tabular-nums">{t("page.total", { n: total.toLocaleString() })}</span>
    </div>
  );
}
