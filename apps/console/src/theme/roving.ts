/** radiogroup 方向鍵／Home／End → 下一索引；無關鍵回 null。 */
export function nextIndex(key: string, i: number, n: number): number | null {
  if (n <= 0) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (i + 1) % n;
  if (key === "ArrowLeft" || key === "ArrowUp") return (i - 1 + n) % n;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return null;
}
