import type { FastifyInstance } from "fastify";
import { ADMIN_API_PATHS, DEFAULT_THRESHOLDS, ThresholdsSchema, type Thresholds } from "@semantic-defense/contracts";
import type { Db, Queryable } from "./db.js";
import { writeAudit } from "./audit.js";
import type { Role } from "./auth.js";

/**
 * ② 成案／自動上榜門檻（MONITOR §7：預設 0.50／0.90；僅 platform_admin 可讀寫，每次變更寫稽核）。
 * - 單列表 thresholds（CHECK 0<=case<=auto<=1）；無列 → 預設值。
 * - 判定端以 loadThresholds 讀值餵給 judgeFlows(flows, thresholds)，與 GET 讀回同一來源。
 * - 變更與稽核（thresholds.update，detail 含 before／after）同一 Db.tx；值未變不寫稽核。
 */
const ADMIN: Role[] = ["platform_admin"];
type Row = { case_threshold: number; auto_threshold: number };
const toThresholds = (r: Row | undefined): Thresholds =>
  r ? { case: r.case_threshold, auto: r.auto_threshold } : { ...DEFAULT_THRESHOLDS };

export async function loadThresholds(db: Queryable): Promise<Thresholds> {
  const r = await db.query<Row>("SELECT case_threshold, auto_threshold FROM thresholds WHERE id");
  return toThresholds(r.rows[0]);
}

export function registerThresholdRoutes(app: FastifyInstance, db: Db, now: () => number): void {
  app.get(ADMIN_API_PATHS.thresholds, { config: { roles: ADMIN } }, async () => loadThresholds(db));

  app.put(ADMIN_API_PATHS.thresholds, { config: { roles: ADMIN } }, async (req, reply) => {
    const parsed = ThresholdsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "請求格式錯誤" });
    const after = parsed.data;
    await db.tx(async (q) => {
      // 先確保有列並鎖住，序列化並行更新，before 才正確
      await q.query(
        "INSERT INTO thresholds (id, case_threshold, auto_threshold) VALUES (TRUE, $1, $2) ON CONFLICT (id) DO NOTHING",
        [DEFAULT_THRESHOLDS.case, DEFAULT_THRESHOLDS.auto],
      );
      const before = toThresholds((await q.query<Row>(
        "SELECT case_threshold, auto_threshold FROM thresholds WHERE id FOR UPDATE")).rows[0]);
      if (before.case === after.case && before.auto === after.auto) return;
      await q.query("UPDATE thresholds SET case_threshold = $1, auto_threshold = $2 WHERE id", [after.case, after.auto]);
      await writeAudit(q, { action: "thresholds.update", actor: req.user!.username, sensor_id: null, at: now(),
        detail: { before, after } });
    });
    return after;
  });
}
