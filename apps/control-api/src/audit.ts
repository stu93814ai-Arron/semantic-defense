import type { FastifyInstance } from "fastify";
import type { Db } from "./db.js";
import type { Role } from "./auth.js";

/**
 * 最小稽核：Postgres audit_events，append-only。
 * 欄位 action／actor（username）／sensor_id／at（epoch ms）／detail（非機密 JSON）。
 * 呼叫端不得傳入 token、secret 或 hash。
 */
export type AuditEvent = { action: string; actor: string; sensor_id: string | null; at: number; detail?: Record<string, unknown> };

export async function writeAudit(db: Db, e: AuditEvent): Promise<void> {
  await db.query(
    "INSERT INTO audit_events (action, actor, sensor_id, at, detail) VALUES ($1,$2,$3,$4,$5)",
    [e.action, e.actor, e.sensor_id, e.at, JSON.stringify(e.detail ?? {})],
  );
}

const ADMIN: Role[] = ["platform_admin"];
type Row = { action: string; actor: string; sensor_id: string | null; at: string; detail: Record<string, unknown> };

export function registerAuditRoute(app: FastifyInstance, db: Db): void {
  app.get("/api/audit", { config: { roles: ADMIN } }, async () => {
    const r = await db.query<Row>("SELECT action, actor, sensor_id, at, detail FROM audit_events ORDER BY id");
    return { items: r.rows.map((x) => ({ ...x, at: Number(x.at) })) };
  });
}
