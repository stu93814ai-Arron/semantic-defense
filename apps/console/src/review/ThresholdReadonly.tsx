import type { Thresholds } from "./thresholds";

/** 審核頁唯讀：顯示目前成案／自動上榜門檻（供 operator 對照）。 */
export function ThresholdReadonly({ value }: { value: Thresholds }) {
  return (
    <p className="card" data-testid="threshold-readonly" role="status">
      目前門檻：成案（case）{value.case}；自動上榜（auto）{value.auto}
    </p>
  );
}
