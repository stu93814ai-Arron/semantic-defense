import type { FastifyError, FastifyInstance, FastifyServerOptions } from "fastify";

/**
 * 錯誤處理（資安殘留 1，與 control-api 同作法；流量平面不得 import control-api，故各自一份）：
 * - 5xx：回固定 body {error:"伺服器錯誤"}，不回 DB 原文；錯誤只寫 log（safeErr、method、url，不記 body、headers、pg detail）。
 * - 4xx：交回 Fastify 預設處理，body 不變。
 */
export const SERVER_ERROR_BODY = Object.freeze({ error: "伺服器錯誤" });

type ErrLike = {
  name?: string; message?: string; code?: string; stack?: string;
  severity?: unknown; table?: string; constraint?: string; column?: string;
};

/**
 * log 用的錯誤摘要。pg 錯誤（帶 severity）的 message／detail／stack 可能嵌入請求值（如 Failing row contains、invalid input syntax），
 * 故只記 code、table、constraint、column；其他錯誤記 name／message／code／stack。
 */
export function safeErr(err: ErrLike): Record<string, unknown> {
  if (typeof err.severity === "string") {
    return { name: err.name, code: err.code, table: err.table, constraint: err.constraint, column: err.column };
  }
  return { name: err.name, message: err.message, code: err.code, stack: err.stack };
}

/** log 用 url：只留 path，去掉 query（?token=… 等可能含憑證）。 */
export const pathOnly = (url: string): string => {
  const i = url.indexOf("?");
  return i === -1 ? url : url.slice(0, i);
};

type ReqLike = { method: string; url: string; host?: string; ip?: string; socket?: { remotePort?: number } };
/** 自訂 req serializer：欄位同 Fastify 預設，但 url 只記 path。 */
export const safeReqSerializer = (req: ReqLike) => ({
  method: req.method, url: pathOnly(req.url), host: req.host, remoteAddress: req.ip, remotePort: req.socket?.remotePort,
});

/**
 * 字串裡的 url 去掉 query（`/p?token=…` → `/p`）；FST_ERR_REP_ALREADY_SENT 等錯誤會把完整 url 寫進 message。
 * 從 `?` 一路切到第一個空白或字串結尾，path 與 query 裡的引號都不會讓切除停下（資安退回 R1：`/p?a"b&token=…`、`/p"x?token=…`；Node 允許 path 含未編碼的 `"`）；
 * 開頭也認 `*`（asterisk-form，如 `OPTIONS *?token=…`，R7）。
 */
const noQuery = (v: unknown): unknown => (typeof v === "string" ? v.replace(/([\/*][^\s?]*)\?\S*/g, "$1") : v);
/** err serializer：欄位同 pino 預設（type＋自有欄位＋message／stack），message／stack 去 query。 */
export const safeErrSerializer = (e: FastifyError) =>
  ({ type: e.name, ...e, message: noQuery(e.message) as string, stack: noQuery(e.stack) as string });
type LogHooks = { logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void): void };
/**
 * pino 在沒給 msg 時直接拿原始 err.message 當 msg（不經 serializer）：補上去 query 的 msg，字串參數也去 query。
 * 直接傳 Error（log.error(err)）時先包成 {err}，才會走 err serializer，頂層 msg 也一併去 query。
 */
const logMethod: LogHooks["logMethod"] = function (args, method) {
  const [first, ...rest] = args;
  const obj = first instanceof Error ? { err: first } : first;
  const err = (obj as { err?: { message?: unknown } } | null)?.err;
  const out = rest.length === 0 && err ? [obj, noQuery(err.message)] : [obj, ...rest].map(noQuery);
  method.apply(this, out);
};

/** 套上 safe serializer（req url 只留 path、err 去 query）的 logger 設定；false 維持關閉，true／省略＝預設 logger。 */
export function withSafeReqLog(logger: FastifyServerOptions["logger"] | undefined): FastifyServerOptions["logger"] {
  if (logger === false) return false;
  const base = logger === true || logger === undefined ? {} : logger;
  return { ...base, hooks: { ...base.hooks, logMethod },
    serializers: { ...base.serializers, req: safeReqSerializer, err: safeErrSerializer } };
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if ((err.statusCode ?? 500) >= 500) {
      req.log.error({ err: safeErr(err), method: req.method, url: pathOnly(req.url) }, "server error");
      return reply.code(500).send(SERVER_ERROR_BODY);
    }
    return reply.send(err);
  });
}
