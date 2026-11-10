import type { Db, Queryable } from "./db.js";
import { writeAudit } from "./audit.js";

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

export type AlertPayload = { delivery_id: string; kind: AlertKind; entry_id?: string; case_id?: string; at?: number };
export type OutboxRow = {
  id: string; audit_id: string | null; channel: AlertChannel; kind: AlertKind; payload: AlertPayload;
  attempts: number; next_attempt_at: string; status: "pending" | "delivered" | "failed";
  error_class: string | null; created_at: string; delivered_at: string | null;
};
export type AlertSender = (row: OutboxRow) => Promise<void>;
export type AlertLog = { error(obj: object, msg: string): void };
export type AlertHealth = { pending: number; failed: number; delivered_1h: number; undelivered: number; last_failed_at: number | null; purged?: number };

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

const KIND_RANK = "CASE kind WHEN 'breaker_open' THEN 0 WHEN 'volume' THEN 1 ELSE 2 END";

export async function enqueueAlerts(
  q: Queryable,
  opts: { channels: readonly AlertChannel[]; kind: AlertKind; now: number; auditId?: number; entryId?: string; caseId?: string },
): Promise<string[]> {
  const ids: string[] = [];
  const base: Record<string, string | number> = { kind: opts.kind };
  if (opts.entryId) base.entry_id = opts.entryId;
  if (opts.caseId) base.case_id = opts.caseId;
  if (opts.kind === "volume" || opts.kind === "breaker_open") base.at = opts.now;
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
  const r = await db.query<{ pending: string; failed: string; delivered_1h: string; last_failed_at: string | null }>(
    `SELECT count(*) FILTER (WHERE status = 'pending') AS pending,
            count(*) FILTER (WHERE status = 'failed') AS failed,
            count(*) FILTER (WHERE status = 'delivered' AND delivered_at > $1) AS delivered_1h,
            max(failed_at) FILTER (WHERE status = 'failed') AS last_failed_at
       FROM alert_outbox`,
    [now - 3_600_000],
  );
  const purged = await db.query<{ n: string }>(
    `SELECT coalesce(sum((detail->>'count')::int), 0) AS n
       FROM audit_events
      WHERE action = 'alert.purged' AND at > $1`,
    [now - 24 * 60 * 60_000],
  );
  const row = r.rows[0]!;
  const pending = Number(row.pending);
  const failed = Number(row.failed);
  return {
    pending, failed, delivered_1h: Number(row.delivered_1h),
    undelivered: pending + failed,
    last_failed_at: row.last_failed_at != null ? Number(row.last_failed_at) : null,
    purged: Number(purged.rows[0]!.n),
  };
}

async function claimDue(q: Queryable, now: number, channels: readonly AlertChannel[], limit: number): Promise<OutboxRow[]> {
  if (channels.length === 0) return [];
  const r = await q.query<OutboxRow>(
    `WITH due AS (
       SELECT id FROM alert_outbox
        WHERE status = 'pending' AND next_attempt_at <= $1 AND channel = ANY($2::text[])
        ORDER BY ${KIND_RANK}, id
        FOR UPDATE SKIP LOCKED
        LIMIT $3
     )
     UPDATE alert_outbox o SET next_attempt_at = $4
       FROM due WHERE o.id = due.id
     RETURNING o.id, o.audit_id, o.channel, o.kind, o.payload, o.attempts,
               o.next_attempt_at, o.status, o.error_class, o.created_at, o.delivered_at`,
    [now, channels, limit, now + ALERT_CLAIM_LEASE_MS],
  );
  return r.rows;
}

async function markDelivered(q: Queryable, id: string, now: number): Promise<void> {
  await q.query(
    "UPDATE alert_outbox SET status = 'delivered', delivered_at = $2, error_class = NULL WHERE id = $1",
    [id, now],
  );
}

async function markFailure(q: Queryable, row: OutboxRow, now: number, errorClass: string, log?: AlertLog): Promise<"failed" | "retried"> {
  const attempts = row.attempts + 1;
  if (attempts >= ALERT_MAX_ATTEMPTS) {
    await q.query(
      "UPDATE alert_outbox SET status = 'failed', attempts = $2, error_class = $3, next_attempt_at = $4, failed_at = $4 WHERE id = $1",
      [row.id, attempts, errorClass, now],
    );
    await writeAudit(q, {
      action: "alert.delivery_failed", actor: "system:auto", sensor_id: null, at: now,
      detail: { delivery_id: String(row.id), channel: row.channel, kind: row.kind, error_class: errorClass, attempts },
    });
    log?.error({ failed: 1, attempts }, "alert delivery exhausted");
    return "failed";
  }
  await q.query(
    "UPDATE alert_outbox SET attempts = $2, error_class = $3, next_attempt_at = $4 WHERE id = $1",
    [row.id, attempts, errorClass, now + alertBackoffMs(attempts)],
  );
  return "retried";
}

export async function purgeAlertOutbox(
  db: Queryable, now: number, maxRows = ALERT_OUTBOX_MAX_ROWS_DEFAULT, log?: AlertLog,
): Promise<number> {
  const stale = await db.query<{ n: string }>(
    `WITH d AS (
       DELETE FROM alert_outbox
        WHERE status IN ('failed','delivered') AND created_at < $1
       RETURNING 1
     ) SELECT count(*) AS n FROM d`,
    [now - ALERT_FAILED_RETENTION_MS],
  );
  let n = Number(stale.rows[0]!.n);
  const total = await db.query<{ n: string }>("SELECT count(*) AS n FROM alert_outbox");
  const overflow = Number(total.rows[0]!.n) - maxRows;
  if (overflow > 0) {
    const cap = await db.query<{ n: string }>(
      `WITH d AS (
         DELETE FROM alert_outbox WHERE id IN (
           SELECT id FROM alert_outbox WHERE status IN ('failed','delivered')
           ORDER BY created_at, id LIMIT $1
         ) RETURNING 1
       ) SELECT count(*) AS n FROM d`,
      [overflow],
    );
    n += Number(cap.rows[0]!.n);
  }
  if (n > 0) {
    await writeAudit(db, {
      action: "alert.purged", actor: "system:auto", sensor_id: null, at: now,
      detail: { count: n },
    });
    log?.error({ purged: n }, "alert outbox purged");
  }
  return n;
}

function senderOf(senders: Partial<Record<AlertChannel, AlertSender>>, channel: AlertChannel): AlertSender | undefined {
  if (channel === "email") return senders.email;
  if (channel === "webhook") return senders.webhook;
  return senders.syslog;
}

function configuredChannels(senders: Partial<Record<AlertChannel, AlertSender>>): AlertChannel[] {
  const out: AlertChannel[] = [];
  if (senders.email) out.push("email");
  if (senders.webhook) out.push("webhook");
  if (senders.syslog) out.push("syslog");
  return out;
}

export async function deliverDueAlerts(
  db: Db, now: number, senders: Partial<Record<AlertChannel, AlertSender>>, log?: AlertLog,
  opts: { maxRows?: number } = {},
): Promise<{ delivered: number; failed: number; retried: number }> {
  await purgeAlertOutbox(db, now, opts.maxRows ?? ALERT_OUTBOX_MAX_ROWS_DEFAULT, log);
  const claimed = await db.tx((q) => claimDue(q, now, configuredChannels(senders), ALERT_DELIVER_BATCH));
  const out = { delivered: 0, failed: 0, retried: 0 };
  for (const row of claimed) {
    const send = senderOf(senders, row.channel);
    if (!send) continue;
    try {
      await send(row);
      await db.tx((q) => markDelivered(q, row.id, now));
      out.delivered += 1;
    } catch (err) {
      const result = await db.tx((q) => markFailure(q, row, now, errorClassOf(err), log));
      if (result === "failed") out.failed += 1;
      else out.retried += 1;
    }
  }
  return out;
}
