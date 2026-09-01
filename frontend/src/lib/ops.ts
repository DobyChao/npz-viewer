/** Binary compare-panel operators. Ids must match backend `ops.OPERATORS`. */

export interface BinaryOp {
  id: string;
  symbol: string;
  label: string;
  display: "gainmap" | "linear";
}

export const BINARY_OPS: readonly BinaryOp[] = [
  { id: "div", symbol: "÷", label: "除法", display: "gainmap" },
  { id: "mul", symbol: "×", label: "乘法", display: "linear" },
];

export const DEFAULT_OP_ID = "div";

export function opById(id: string): BinaryOp {
  return BINARY_OPS.find((item) => item.id === id) ?? BINARY_OPS[0];
}

export function formatOpExpr(opId: string, leftIndex: number, rightIndex: number): string {
  return `${leftIndex + 1} ${opById(opId).symbol} ${rightIndex + 1}`;
}

export function formatOpKeys(opId: string, leftKey: string, rightKey: string): string {
  return `${leftKey} ${opById(opId).symbol} ${rightKey}`;
}

function pathTail(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || path;
}

/** Dropdown label: slot + key, plus a file hint when keys collide or tiles span files. */
export function operandOptionLabel(
  tile: { id: string; key: string; npzName: string; npzPath: string },
  index: number,
  tiles: { id: string; key: string; npzName: string; npzPath: string }[],
): string {
  const keyClash = tiles.some((other) => other.id !== tile.id && other.key === tile.key);
  const multiFile = tiles.some((other) => other.npzPath !== tiles[0]?.npzPath);
  if (!keyClash && !multiFile) return `${index + 1} ${tile.key}`;
  const nameClash = tiles.some(
    (other) => other.id !== tile.id && other.key === tile.key && other.npzName === tile.npzName,
  );
  const hint = nameClash ? pathTail(tile.npzPath) : tile.npzName;
  return `${index + 1} ${tile.key} · ${hint}`;
}
