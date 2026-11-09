import { useEffect, useState, type FormEvent } from "react";
import { validateThresholds, type Thresholds } from "./thresholds";

export type ThresholdSaveResult =
  | { ok: true; notice: string }
  | { ok: false; message: string };

type Props = {
  value: Thresholds;
  onSave: (next: Thresholds) => ThresholdSaveResult;
};

/**
 * 白名單頁可編輯門檻區塊（此路由僅 platform_admin 可進）。
 * 畫面顯示≠授權；真正授權由 A 組 API 執行。
 */
export function ThresholdEditor({ value, onSave }: Props) {
  const [caseStr, setCaseStr] = useState(String(value.case));
  const [autoStr, setAutoStr] = useState(String(value.auto));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setCaseStr(String(value.case));
    setAutoStr(String(value.auto));
  }, [value.case, value.auto]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const next = {
      case: Number(caseStr),
      auto: Number(autoStr),
    };
    const v = validateThresholds(next);
    if (!v.ok) {
      setNotice(null);
      setError("門檻須滿足 0 ≤ case ≤ auto ≤ 1");
      return;
    }
    const r = onSave(v.value);
    if (!r.ok) {
      setNotice(null);
      setError(r.message);
      return;
    }
    setError(null);
    setNotice(r.notice);
  }

  return (
    <section className="card" data-testid="threshold-editor">
      <h2>成案／自動上榜門檻</h2>
      <form onSubmit={onSubmit}>
        <label>
          成案門檻（case）
          <input
            data-testid="threshold-case"
            type="number"
            step="any"
            min={0}
            max={1}
            value={caseStr}
            onChange={(ev) => setCaseStr(ev.target.value)}
          />
        </label>{" "}
        <label>
          自動上榜門檻（auto）
          <input
            data-testid="threshold-auto"
            type="number"
            step="any"
            min={0}
            max={1}
            value={autoStr}
            onChange={(ev) => setAutoStr(ev.target.value)}
          />
        </label>{" "}
        <button className="btn btn-primary" type="submit" data-testid="threshold-save">
          儲存門檻
        </button>
      </form>
      {error ? <p data-testid="threshold-error">{error}</p> : null}
      {notice ? (
        <p data-testid="threshold-audit-notice" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
