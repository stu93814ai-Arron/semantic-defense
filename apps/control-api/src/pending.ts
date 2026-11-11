/**
 * 待審案件列表（GET /api/blacklist/pending）。
 * 只回 state=open 且尚未到期的案件；欄位嚴格對應契約 PendingCandidate。
 */
import type { FastifyInstance } from "fastify";
import { ADMIN_API_PATHS as P } from "@semantic-defense/contracts";
import type { Db } from "./db.js";
import type { Role } from "./auth.js";

const OPERATOR: Role[] = ["operator"];
const iso = (ms: string | number): string => new Date(Number(ms)).toISOString();

type PendingRow = {
  case_id: string;
  ip: string;
  max_confidence: number;
  hit_count: number;
  created_at: string;
  last_hit_at: string;
};

export function registerPendingRoutes(app: FastifyInstance, db: Db, now: () => number): void {
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
}
