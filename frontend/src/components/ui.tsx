import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import clsx from "clsx";
import { AlertTriangle, Check, Copy, Loader2 } from "lucide-react";

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx("animate-spin text-zinc-500", className)} size={16} />;
}

export function SectionHeader({
  title,
  children,
}: {
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3">
      <span className="truncate text-xs font-medium tracking-wide text-zinc-400 uppercase">
        {title}
      </span>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </div>
  );
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  variant?: "ghost" | "solid" | "danger";
};

export function Button({ active, variant = "ghost", className, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={clsx(
        "inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-40",
        variant === "ghost" &&
          (active
            ? "bg-cyan-500/15 text-cyan-300"
            : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"),
        variant === "solid" && "bg-cyan-600 text-white hover:bg-cyan-500",
        variant === "danger" && "text-red-400 hover:bg-red-500/10 hover:text-red-300",
        className,
      )}
      {...rest}
    />
  );
}

export function IconButton({
  title,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  const { active, ...buttonProps } = rest;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={clsx(
        "inline-flex h-7 w-7 items-center justify-center rounded transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "bg-cyan-500/15 text-cyan-300"
          : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100",
        className,
      )}
      {...buttonProps}
    />
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={clsx("inline-flex rounded border border-zinc-700 p-0.5", className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          onClick={() => onChange(option.value)}
          className={clsx(
            "rounded px-2 py-0.5 text-xs transition-colors",
            option.value === value
              ? "bg-cyan-600 text-white"
              : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      className={clsx(
        "inline-flex cursor-pointer items-center gap-1.5 text-xs select-none",
        disabled && "cursor-not-allowed opacity-40",
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3.5 w-3.5 accent-cyan-500"
      />
      {label}
    </label>
  );
}

export function TextInput({
  className,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={clsx(
        "min-w-0 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200",
        "placeholder:text-zinc-600 focus:border-cyan-600 focus:outline-none",
        className,
      )}
      {...rest}
    />
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  className,
  title,
  ...rest
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
  title?: string;
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange">) {
  return (
    <select
      title={title}
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      className={clsx(
        "rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-xs text-zinc-300",
        "focus:border-cyan-600 focus:outline-none",
        className,
      )}
      {...rest}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure context; fall back for plain-http deployments.
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
  }
}

export function CopyButton({
  value,
  title = "复制",
  className,
  children,
}: {
  value: string;
  title?: string;
  className?: string;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(
    async (event: React.MouseEvent) => {
      event.stopPropagation();
      await writeClipboard(value);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    },
    [value],
  );

  return (
    <Button
      onClick={copy}
      title={title}
      className={clsx(copied && "text-emerald-400", className)}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {children}
    </Button>
  );
}

export function ErrorBox({
  error,
  className,
  compact,
}: {
  error: unknown;
  className?: string;
  compact?: boolean;
}) {
  const message = error instanceof Error ? error.message : String(error);
  const hint =
    error && typeof error === "object" && "hint" in error
      ? ((error as { hint?: string | null }).hint ?? null)
      : null;
  return (
    <div
      className={clsx(
        "flex items-start gap-2 rounded border border-red-900/60 bg-red-950/40 text-red-300",
        compact ? "px-2 py-1 text-[11px]" : "p-3 text-xs",
        className,
      )}
    >
      <AlertTriangle size={compact ? 12 : 14} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <div className="break-words">{message}</div>
        {hint && <div className="mt-1 text-red-400/70">{hint}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-xs text-zinc-600">
      {children}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  width = "max-w-lg",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-10"
      onClick={onClose}
    >
      <div
        className={clsx(
          "w-full rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl",
          width,
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
          <h2 className="text-sm font-medium text-zinc-200">{title}</h2>
          <Button onClick={onClose}>关闭</Button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
