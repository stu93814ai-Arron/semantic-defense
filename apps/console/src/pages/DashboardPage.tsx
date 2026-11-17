import { useEffect, useState, type ReactNode } from "react";
import type { AdminApiResult } from "../review/adminApi";
import { reviewSource } from "../review/reviewSource";
import type { ListedEntry, PendingCandidate } from "../review/types";
import { titleFor } from "../roles";
import { summarizeListed } from "./dashboardStats";
import { DemoDataMarker } from "../review/DemoDataMarker";

type LoadState<T> =
  | { status: "loading" }
  | { status: "ok"; value: T }
  | { status: "err"; message: string };

function toState<T>(r: AdminApiResult<T>): LoadState<T> {
  if (r.ok) return { status: "ok", value: r.value };
  return { status: "err", message: r.message };
}

function bodyOf<T>(state: LoadState<T>, ok: (value: T) => ReactNode): ReactNode {
  if (state.status === "loading") return <p>載入中…</p>;
  if (state.status === "err") return <p role="alert">{state.message}</p>;
  return ok(state.value);
}

function PendingWidget({ state }: { state: LoadState<PendingCandidate[]> }) {
  return (
    <section className="card" data-testid="dashboard-pending">
      <h2>待審</h2>
      {bodyOf(state, (items) => (
        <p className="dashboard-metric">{items.length}</p>
      ))}
    </section>
  );
}

function ListedWidget(props: { state: LoadState<ListedEntry[]>; now: string }) {
  return (
    <section className="card" data-testid="dashboard-listed">
      <h2>生效封鎖</h2>
      {bodyOf(props.state, (items) => {
        const s = summarizeListed(items, props.now);
        return (
          <ul className="dashboard-listed-stats">
            <li>共 {s.total} 筆</li>
            <li>今日自動 {s.todayAuto}</li>
            <li>人工 {s.todayManual}</li>
            <li>24 小時內到期 {s.expiringWithin24h}</li>
          </ul>
        );
      })}
    </section>
  );
}

function UnwiredWidgets() {
  return (
    <section className="card" data-testid="dashboard-unwired">
      <h2>尚未接線</h2>
      <ul>
        <li>自動上榜：尚未接線</li>
        <li>未成案：尚未接線</li>
        <li>白名單略過：尚未接線</li>
        <li>鏡像流量：尚未接線</li>
        <li>系統健康：尚未接線</li>
      </ul>
    </section>
  );
}

export function DashboardPage({ nowIso }: { nowIso?: string } = {}) {
  const now = nowIso ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const [pending, setPending] = useState<LoadState<PendingCandidate[]>>({ status: "loading" });
  const [listed, setListed] = useState<LoadState<ListedEntry[]>>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void reviewSource.listPending().then((p) => {
      if (!cancelled) setPending(toState(p));
    });
    void reviewSource.listActive().then((l) => {
      if (!cancelled) setListed(toState(l));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main data-testid="dashboard">
      <p className="eyebrow">監看 / 總覽</p>
      <h1>{titleFor("/dashboard")}</h1>
      <DemoDataMarker />
      <p>今日 00:00 起 · Asia/Taipei</p>
      <p className="mode-pill" data-testid="dashboard-mode">
        模式：尚未接線
      </p>
      <PendingWidget state={pending} />
      <ListedWidget state={listed} now={now} />
      <UnwiredWidgets />
      <section className="card" data-testid="dashboard-ai">
        AI 尚未啟用
      </section>
    </main>
  );
}
