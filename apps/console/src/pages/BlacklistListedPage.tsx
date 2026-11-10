import { useEffect, useState } from "react";
import { useAuth } from "../auth";
import { reviewSource } from "../review/reviewSource";
import type { ListedEntry, SourceFilter } from "../review/types";

export function BlacklistListedPage() {
  const { user } = useAuth();
  const [filter, setFilter] = useState<SourceFilter>("all");
  const [tick, setTick] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [items, setItems] = useState<ListedEntry[]>([]);
  const unreachable = reviewSource.isUnreachable();

  useEffect(() => {
    let cancelled = false;
    void reviewSource.listActive(filter).then((rows) => {
      if (!cancelled) setItems(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [tick, filter]);

  async function onWithdraw(id: string) {
    if (!user) return;
    const r = await reviewSource.withdraw(id, user.username);
    setMessage(r.ok ? "已撤回" : (r.message ?? "撤回失敗"));
    setTick((n) => n + 1);
  }

  return (
    <main>
      <h1>黑名單撤回</h1>
      <div role="group" aria-label="來源篩選">
        {(["all", "auto", "manual"] as const).map((f) => (
          <button
            key={f}
            type="button"
            className="btn"
            data-testid={`filter-${f}`}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? "全部" : f === "auto" ? "自動" : "人工"}
          </button>
        ))}
      </div>
      {message ? <p role="status">{message}</p> : null}
      {unreachable ? (
        <div data-testid="backend-unreachable" className="card" role="alert">
          <p>後端無法連線，請稍後再試</p>
        </div>
      ) : null}
      {!unreachable && items.length === 0 ? (
        <div data-testid="empty-state" className="card">
          <p>尚無已上榜黑名單</p>
        </div>
      ) : null}
      {!unreachable && items.length > 0 ? (
        <ul data-testid="blacklist-listed">
          {items.map((item) => (
            <li key={item.entry_id} className="card">
              <p>
                {item.ip}（{item.source === "auto" ? "自動" : "人工"}）
              </p>
              <button
                type="button"
                className="btn btn-primary"
                data-testid={`withdraw-${item.entry_id}`}
                onClick={() => void onWithdraw(item.entry_id)}
              >
                撤回
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}
