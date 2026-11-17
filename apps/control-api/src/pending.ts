/**
 * 待審案件：列表、核准與退回。
 * 列表只回 open 且尚未到期；核准成功回應重用既有 BlocklistEntry。
 * 稽核只寫 case_id（核准另加 entry_id），不得含 IP 或退回理由。白名單以 SHARE 鎖重查必擋；冷卻期不擋人工核准。退回不收本文。
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ADMIN_API_PATHS as P, type BlocklistEntry } from "@semantic-defense/contracts";
import type { Db, Queryable } from "./db.js";
import type { Role } from "./auth.js";
import { writeAudit } from "./audit.js";
import { AUTO_LIST_TTL_MS, loadAllowlist } from "./auto-blacklist.js";
import { lockAllowlistShare } from "./auto-breaker.js";
import { insertActiveBlocklistEntry } from "./blocklist-store.js";
import { ApproveBlocked, assertUnderApproveCap, recordApproveBlocked, type ApproveGuardConfig } from "./approve-guard.js";

const OPERATOR: Role[] = ["operator"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MISSING = "查無待審案件";
const iso = (ms: string | number): string => new Date(Number(ms)).toISOString();

type PendingRow = {
  case_id: string;
  ip: string;
  max_confidence: number;
  hit_count: number;
  created_at: string;
  last_hit_at: string;
};

class PendingConflict extends Error {
  readonly error: string;
  constructor(error: string) {
    super(error);
    this.name = "PendingConflict";
    this.error = error;
  }
}

type CaseCur = { state: string; created_at: string; expires_at: string };

/** 條件式 UPDATE 未命中時，依現況對應 404 或 409 訊息（不含 IP）。 */
async function conflictIfUnclaimed(q: Queryable, id: string, at: number): Promise<404 | never> {
  const cur = await q.query<CaseCur>(
    "SELECT state, created_at, expires_at FROM blacklist_cases WHERE case_id = $1", [id],
  );
  const row = cur.rows[0];
  if (!row) return 404;
  if (row.state === "approved") throw new PendingConflict("已核准");
  if (row.state === "rejected") throw new PendingConflict("已退回");
  if (row.state === "auto_listed") throw new PendingConflict("已自動上榜");
  if (row.state === "open" && Number(row.created_at) > at) throw new PendingConflict("clock_skew");
  throw new PendingConflict("已到期");
}

async function runPending<T>(
  reply: FastifyReply, fn: () => Promise<T | 404>, onBlocked: (e: ApproveBlocked) => Promise<void>,
): Promise<T | undefined> {
  try {
    const out = await fn();
    if (out === 404) {
      await reply.code(404).send({ error: MISSING });
      return undefined;
    }
    return out;
  } catch (e) {
    if (e instanceof ApproveBlocked) await onBlocked(e);
    if (e instanceof PendingConflict || e instanceof ApproveBlocked) {
      await reply.code(e instanceof ApproveBlocked ? e.status : 409).send({ error: e.error });
      return undefined;
    }
    throw e;
  }
}

type CaseCtx = { id: string; at: number; actor: string };

/**
 * 核准／退回共用開頭：路徑參數只收小寫 UUID（否則 404），取 app 時鐘與操作者，
 * 在單一交易內執行 fn，由 runPending 對應 404／409；成功才交給 done 回應。
 */
function postCaseAction<T>(
  app: FastifyInstance, db: Db, now: () => number, path: string,
  fn: (q: Queryable, c: CaseCtx) => Promise<T | 404>,
  done: (reply: FastifyReply, out: T) => unknown,
): void {
  app.post<{ Params: { caseId: string } }>(path, { config: { roles: OPERATOR } }, async (req, reply) => {
    const id = req.params.caseId;
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: MISSING });
    const c: CaseCtx = { id, at: now(), actor: req.user!.username };
    // 防護擋下時主交易已回滾；被擋稽核在另一筆短交易寫。
    const out = await runPending<T>(reply, () => db.tx((q) => fn(q, c)), (e) => recordApproveBlocked(db, c, e.reason));
    if (out !== undefined) return done(reply, out);
  });
}

export function registerPendingRoutes(app: FastifyInstance, db: Db, now: () => number, guard: ApproveGuardConfig): void {
  app.get(P.blacklistPending, { config: { roles: OPERATOR } }, async () => {
    const r = await db.query<PendingRow>(
      `SELECT case_id, ip, max_confidence, hit_count, created_at, last_hit_at
       FROM blacklist_cases
       WHERE state = 'open' AND expires_at > $1
       ORDER BY created_at, case_id`,
      [now()],
    );
    return {
      items: r.rows.map((row) => ({
        ip: row.ip,
        confidence: row.max_confidence,
        case_id: row.case_id,
        created_at: iso(row.created_at),
        hit_count: row.hit_count,
        last_hit_at: iso(row.last_hit_at),
      })),
    };
  });

  postCaseAction<BlocklistEntry>(app, db, now, P.blacklistPendingApprove, async (q, { id, at, actor }) => {
    // 先 SHARE 再改案件：與白名單寫入同一鎖順序，核准當下重查白名單。
    await lockAllowlistShare(q);
    // 上限先判（SHARE 之後拿 actor 鎖再計數）：超限後不再透露案件狀態。
    await assertUnderApproveCap(q, actor, at, guard.perHour);
    const r = await q.query<{ case_id: string; ip: string; max_confidence: number }>(
      `UPDATE blacklist_cases
       SET state = 'approved', resolved_by = $2, resolved_at = $3
       WHERE case_id = $1 AND state = 'open' AND expires_at > $3 AND created_at <= $3
       RETURNING case_id, ip, max_confidence`,
      [id, actor, at],
    );
    const row = r.rows[0];
    if (!row) return conflictIfUnclaimed(q, id, at);
    if ((await loadAllowlist(q, at))(row.ip)) throw new PendingConflict("已在白名單");
    const entry = await insertActiveBlocklistEntry(q, {
      entry_id: randomUUID(),
      ip: row.ip,
      source: "manual",
      confidence: row.max_confidence,
      case_id: row.case_id,
      created_at: at,
      expires_at: at + AUTO_LIST_TTL_MS,
      approved_by: actor,
      approved_at: at,
    }, at);
    if (!entry) throw new PendingConflict("已上榜");
    await writeAudit(q, {
      action: "blacklist.approve", actor, sensor_id: null, at,
      detail: { case_id: row.case_id, entry_id: entry.entry_id },
    });
    return entry;
  }, (_reply, entry) => entry);

  postCaseAction<true>(app, db, now, P.blacklistPendingReject, async (q, { id, at, actor }) => {
    const r = await q.query<{ case_id: string }>(
      `UPDATE blacklist_cases
       SET state = 'rejected', resolved_by = $2, resolved_at = $3
       WHERE case_id = $1 AND state = 'open' AND expires_at > $3 AND created_at <= $3
       RETURNING case_id`,
      [id, actor, at],
    );
    if (!r.rows[0]) return conflictIfUnclaimed(q, id, at);
    await writeAudit(q, { action: "blacklist.reject", actor, sensor_id: null, at, detail: { case_id: id } });
    return true as const;
  }, (reply) => reply.code(204).send());
}
