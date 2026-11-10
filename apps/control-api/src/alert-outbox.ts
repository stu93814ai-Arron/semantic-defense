import type { Queryable } from "./db.js";

export const ALERT_CHANNELS = ["email", "webhook", "syslog"] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];
export const ALERT_KINDS = ["auto_list", "volume", "breaker_open"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_MAX_ATTEMPTS = 8;
export const ALERT_BACKOFF_START_MS = 1_000;
export const ALERT_BACKOFF_CAP_MS = 15 * 60_000;
export const ALERT_CLAIM_LEASE_MS = 60_000;
export const ALERT_DELIVER_BATCH = 16;
export const ALERT_FAILED_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const ALERT_OUTBOX_MAX_ROWS_DEFAULT = 10_000;

export type AlertPayload = { delivery_id: string; kind: AlertKind; entry_id?: string; case_id?: string };
export type OutboxRow = {
  id: string; audit_id: string | null; channel: AlertChannel; kind: AlertKind; payload: AlertPayload;
  attempts: number; next_attempt_at: string; status: "pending" | "delivered" | "failed";
  error_class: string | null; created_at: string; delivered_at: string | null;
};
export type AlertHealth = { pending: number; failed: number; delivered_1h: number; purged?: number };

export class AlertSendError extends Error {
  constructor(readonly errorClass: string) {
    super(errorClass);
    this.name = "AlertSendError";
  }
}

export function alertBackoffMs(failures: number): number {
  const exp = Math.max(0, Math.min(failures - 1, 20));
  return Math.min(ALERT_BACKOFF_START_MS * 2 ** exp, ALERT_BACKOFF_CAP_MS);
}

export function errorClassOf(err: unknown): string {
  return err instanceof AlertSendError ? err.errorClass : "send_failed";
}

export function enabledAlertChannels(
  env: Record<string, string | undefined> = process.env,
  override?: readonly AlertChannel[],
): AlertChannel[] {
  if (override) return [...override];
  const out: AlertChannel[] = [];
  if (env.SD_ALERT_EMAIL_TO?.trim()) out.push("email");
  if (env.SD_ALERT_WEBHOOK_URL?.trim()) out.push("webhook");
  if (env.SD_ALERT_SYSLOG_HOST?.trim()) out.push("syslog");
  return out;
}

/** Webhook 已設定時，金鑰必填且至少 32 bytes。 */
export function assertWebhookSecret(env: Record<string, string | undefined> = process.env): void {
  if (!env.SD_ALERT_WEBHOOK_URL?.trim()) return;
  const secret = env.SD_ALERT_WEBHOOK_HMAC_SECRET ?? "";
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("SD_ALERT_WEBHOOK_HMAC_SECRET must be at least 32 bytes");
  }
}

export async function enqueueAlerts(
  q: Queryable,
  opts: { channels: readonly AlertChannel[]; kind: AlertKind; now: number; auditId?: number; entryId?: string; caseId?: string },
): Promise<string[]> {
  const ids: string[] = [];
  const base: Record<string, string> = { kind: opts.kind };
  if (opts.entryId) base.entry_id = opts.entryId;
  if (opts.caseId) base.case_id = opts.caseId;
  const raw = JSON.stringify(base);
  for (const channel of opts.channels) {
    const r = await q.query<{ id: string }>(
      `INSERT INTO alert_outbox (audit_id, channel, kind, payload, attempts, next_attempt_at, status, created_at)
       VALUES ($1,$2,$3,$4::jsonb,0,$5,'pending',$5) RETURNING id`,
      [opts.auditId ?? null, channel, opts.kind, raw, opts.now],
    );
    const id = r.rows[0]!.id;
    await q.query(
      "UPDATE alert_outbox SET payload = payload || jsonb_build_object('delivery_id', $2::text) WHERE id = $1",
      [id, id],
    );
    ids.push(id);
  }
  return ids;
}

export async function alertHealthCounts(db: Queryable, now: number): Promise<AlertHealth> {
  const r = await db.query<{ pending: string; failed: string; delivered_1h: string }>(
    `SELECT count(*) FILTER (WHERE status = 'pending') AS pending,
            count(*) FILTER (WHERE status = 'failed') AS failed,
            count(*) FILTER (WHERE status = 'delivered' AND delivered_at > $1) AS delivered_1h
       FROM alert_outbox`,
    [now - 3_600_000],
  );
  const row = r.rows[0]!;
  return { pending: Number(row.pending), failed: Number(row.failed), delivered_1h: Number(row.delivered_1h) };
}
