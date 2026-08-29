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
