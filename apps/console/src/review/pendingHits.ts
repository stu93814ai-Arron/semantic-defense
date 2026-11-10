/** 待審列命中欄位摘要（契約 hit_count／last_hit_at）。 */
export function formatPendingHits(item: { hit_count: number; last_hit_at: string }): string {
  return `命中 ${item.hit_count} 次；最後 ${item.last_hit_at}`;
}
