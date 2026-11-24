import { forwardRef, useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { AutoListSetting } from "@semantic-defense/contracts/browser";
import type { Role } from "../roles";
import type { AdminApiResult } from "./adminApi";

export type AutoListSource = {
  getAutoList: () => Promise<AdminApiResult<AutoListSetting>>;
  putAutoList: (input: AutoListSetting) => Promise<AdminApiResult<AutoListSetting>>;
};

type Props = {
  role: Role | undefined;
  source: AutoListSource;
};

type ReadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; enabled: boolean };

/** 自動上榜開關：僅 platform_admin 顯示（畫面顯示，授權由後端判斷）；顯示值一律以 GET 為準，寫入後必重讀。 */
export function AutoListSwitch({ role, source }: Props) {
  if (role !== "platform_admin") return null;
  return <AutoListSwitchInner source={source} />;
}

function useAutoList(source: AutoListSource) {
  const [read, setRead] = useState<ReadState>({ kind: "loading" });
  const [writeError, setWriteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  // 寫入後重讀時保留上一次 GET 的值（開關停用中），避免焦點遺失；首次與重試才進入載入狀態。
  const load = useCallback(async (reset = true) => {
    if (reset) setRead({ kind: "loading" });
    const r = await source.getAutoList();
    if (!alive.current) return;
    setRead(r.ok ? { kind: "ready", enabled: r.value.enabled } : { kind: "error", message: r.message });
  }, [source]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  async function write(enabled: boolean) {
    setBusy(true);
    setWriteError(null);
    const r = await source.putAutoList({ enabled });
    if (!alive.current) return;
    if (!r.ok) setWriteError(r.message);
    await load(false);
    if (alive.current) setBusy(false);
  }

  return { read, writeError, setWriteError, busy, load, write };
}

function AutoListSwitchInner({ source }: { source: AutoListSource }) {
  const { read, writeError, setWriteError, busy, load, write } = useAutoList(source);
  const [confirming, setConfirming] = useState(false);
  const switchRef = useRef<HTMLButtonElement>(null);

  function onToggle() {
    // 寫入中用 aria-disabled（不用 disabled），焦點留在開關；此處直接忽略點擊。
    if (busy || read.kind !== "ready") return;
    if (read.enabled) {
      void write(false);
    } else {
      setWriteError(null);
      setConfirming(true);
    }
  }

  function closeDialog() {
    setConfirming(false);
    switchRef.current?.focus();
  }

  return (
    <div className="auto-list" data-testid="auto-list">
      <h3>自動上榜</h3>
      {read.kind === "loading" ? <p className="muted">讀取中…</p> : null}
      {read.kind === "error" ? (
        <>
          <p role="alert" data-testid="auto-list-read-error">
            {read.message}
          </p>
          <button type="button" className="btn" onClick={() => void load()}>
            重新讀取
          </button>
        </>
      ) : null}
      {read.kind === "ready" ? (
        <SwitchRow ref={switchRef} enabled={read.enabled} busy={busy} onToggle={onToggle} />
      ) : null}
      {writeError ? (
        <p role="alert" data-testid="auto-list-write-error">
          {writeError}
        </p>
      ) : null}
      {confirming ? (
        <ConfirmEnableDialog
          onCancel={closeDialog}
          onConfirm={() => {
            closeDialog();
            void write(true);
          }}
        />
      ) : null}
    </div>
  );
}

const SwitchRow = forwardRef<
  HTMLButtonElement,
  { enabled: boolean; busy: boolean; onToggle: () => void }
>(function SwitchRow({ enabled, busy, onToggle }, ref) {
  const labelId = useId();
  const switchId = useId();
  return (
    <div className="auto-list__row">
      <button
        ref={ref}
        id={switchId}
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-labelledby={labelId}
        aria-busy={busy}
        className="switch"
        data-state={enabled ? "on" : "off"}
        aria-disabled={busy}
        onClick={onToggle}
      >
        <span className="switch__thumb" aria-hidden="true" />
      </button>
      <label id={labelId} htmlFor={switchId} className="auto-list__label">
        自動上榜開關
      </label>
      <span data-testid="auto-list-state" className="auto-list__state">
        {enabled ? "已開啟" : "已關閉"}
      </span>
    </div>
  );
});

function ConfirmEnableDialog(props: { onCancel: () => void; onConfirm: () => void }) {
  const titleId = useId();
  const descId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    e.preventDefault();
    const next = document.activeElement === cancelRef.current ? confirmRef : cancelRef;
    next.current?.focus();
  }

  return (
    <div className="dialog-backdrop">
      <div
        className="dialog card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>開啟自動上榜？</h2>
        <div id={descId}>
          <p>開啟後只影響之後的判定，不會回頭重新判定過去的命中或待審案件。</p>
          <p>之後若再關閉，已自動上榜的條目不會撤銷，會依原到期時間自然失效。</p>
        </div>
        <div className="dialog__actions">
          <button ref={cancelRef} type="button" className="btn" onClick={props.onCancel}>
            取消
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="btn btn-primary"
            onClick={props.onConfirm}
          >
            確認開啟
          </button>
        </div>
      </div>
    </div>
  );
}
