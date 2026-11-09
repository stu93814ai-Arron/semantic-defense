import type { FastifyError, FastifyInstance } from "fastify";

/**
 * 錯誤處理（資安殘留 1）：
 * - 5xx：回固定 body {error:"伺服器錯誤"}，不回 DB 原文／約束名／表名；錯誤只寫 log（只記 err 與 method／url，不記 request body、headers）。
 * - 壞 JSON（BAD_JSON_CODE）：400 固定 body {error:"請求格式錯誤"}，不外洩 parser 原文。
 * - 其他 4xx：交回 Fastify 預設處理，body 維持原樣。
 */
export const BAD_JSON_CODE = "SD_BAD_JSON";
export const SERVER_ERROR_BODY = Object.freeze({ error: "伺服器錯誤" });

/** 壞 JSON 錯誤：帶 400 與固定 code，供錯誤處理辨識；不保留 parser 原文。 */
export function badJsonError(): FastifyError {
  return Object.assign(new Error("invalid json body"), { statusCode: 400, code: BAD_JSON_CODE, name: "BadJson" }) as FastifyError;
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err, method: req.method, url: req.url }, "server error");
      return reply.code(500).send(SERVER_ERROR_BODY);
    }
    if (err.code === BAD_JSON_CODE) return reply.code(400).send({ error: "請求格式錯誤" });
    return reply.send(err);
  });
}
