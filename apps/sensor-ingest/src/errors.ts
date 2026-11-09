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

/** 套上 safeReqSerializer 的 logger 設定；false 維持關閉，true／省略＝預設 logger。 */
export function withSafeReqLog(logger: FastifyServerOptions["logger"] | undefined): FastifyServerOptions["logger"] {
  if (logger === false) return false;
  const base = logger === true || logger === undefined ? {} : logger;
  return { ...base, serializers: { ...base.serializers, req: safeReqSerializer } };
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
