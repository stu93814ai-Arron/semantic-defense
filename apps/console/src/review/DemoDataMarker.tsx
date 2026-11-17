import { reviewSource } from "./reviewSource";

/** 當 reviewSource 因 VITE_DEMO_FALLBACK 提供 demo 資料時，標示「示範資料」。 */
export function DemoDataMarker() {
  if (!reviewSource.isDemo()) return null;
  return (
    <p role="status" data-testid="demo-data-marker" className="demo-data-marker">
      示範資料
    </p>
  );
}
