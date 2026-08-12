import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { formatNumber } from "../../lib/format";
import type { KeyMeta } from "../../lib/types";
import { ErrorBox, Spinner } from "../ui";

function ValueGrid({ values }: { values: number[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((value, index) => (
        <span
          key={index}
          className="rounded bg-zinc-800/80 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300 tabular-nums"
          title={`[${index}]`}
        >
          {formatNumber(value)}
        </span>
      ))}
    </div>
  );
}

function Matrix({ rows }: { rows: number[][] }) {
  return (
    <table className="font-mono text-[11px] tabular-nums">
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((value, columnIndex) => (
              <td
                key={columnIndex}
                className="border border-zinc-800 px-2 py-0.5 text-right text-zinc-300"
              >
                {formatNumber(value)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function isNumberMatrix(value: unknown): value is number[][] {
  return Array.isArray(value) && value.every((row) => Array.isArray(row));
}

function isNumberList(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number" || item === null);
}

function isTruncatedVector(value: unknown): value is { head: number[]; tail: number[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "head" in value &&
    "tail" in value &&
    Array.isArray((value as { head: unknown }).head)
  );
}

export function DataCard({ path, meta }: { path: string; meta: KeyMeta }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["npz-data", path, meta.name],
    queryFn: () => api.data(path, meta.name),
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-3 text-xs text-zinc-500">
        <Spinner /> 读取中
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-2">
        <ErrorBox error={error} compact />
      </div>
    );
  }
  if (!data) return null;

  const { values } = data;

  return (
    <div className="space-y-2 p-3">
      {meta.kind === "scalar" && typeof values !== "object" && (
        <div className="font-mono text-lg text-zinc-100">
          {typeof values === "number" ? formatNumber(values) : String(values)}
        </div>
      )}

      {isTruncatedVector(values) && (
        <div className="space-y-1.5">
          <div>
            <div className="mb-1 text-[10px] text-zinc-600">前 {values.head.length} 个</div>
            <ValueGrid values={values.head} />
          </div>
          <div>
            <div className="mb-1 text-[10px] text-zinc-600">后 {values.tail.length} 个</div>
            <ValueGrid values={values.tail} />
          </div>
        </div>
      )}

      {isNumberMatrix(values) && <Matrix rows={values} />}

      {!isNumberMatrix(values) && isNumberList(values) && <ValueGrid values={values as number[]} />}

      {typeof values === "string" && (
        <pre className="max-h-40 overflow-auto rounded bg-zinc-900 p-2 font-mono text-[11px] break-all whitespace-pre-wrap text-zinc-400">
          {values}
        </pre>
      )}

      {values === null && (
        <div className="text-xs text-zinc-600">该数组维度过高，仅提供统计信息。</div>
      )}

      {data.stats && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-zinc-800 pt-2 font-mono text-[10px] text-zinc-500 tabular-nums">
          <span>min {formatNumber(data.stats.min)}</span>
          <span>max {formatNumber(data.stats.max)}</span>
          <span>mean {formatNumber(data.stats.mean)}</span>
          <span>std {formatNumber(data.stats.std)}</span>
          <span>n {data.stats.count.toLocaleString()}</span>
          {data.stats.nan_count > 0 && (
            <span className="text-amber-500">nan {data.stats.nan_count}</span>
          )}
        </div>
      )}
    </div>
  );
}
