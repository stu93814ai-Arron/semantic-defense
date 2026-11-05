import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type ControlApi } from "./helpers/app.js";

/**
 * 準則：流量平面與管理平面分離（階段 2 — 管理側）。
 * control-api 只綁管理埠，不充當反向代理／流量入口；非管理 API 路徑須 404 且不得轉發。
 */

let app: ControlApi | undefined;
let sentinel: http.Server | undefined;
let sentinelHits = 0;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  if (sentinel) {
    await new Promise<void>((resolve, reject) => {
      sentinel!.close((err) => (err ? reject(err) : resolve()));
    });
    sentinel = undefined;
  }
  sentinelHits = 0;
});

async function startSentinel(): Promise<{ origin: string }> {
  sentinelHits = 0;
  sentinel = http.createServer((_req, res) => {
    sentinelHits += 1;
    res.statusCode = 200;
    res.end("sentinel");
  });
  await new Promise<void>((resolve) => {
    sentinel!.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = sentinel.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${addr.port}` };
}

describe("平面分離：control-api 僅管理平面", () => {
  it("buildApp({ management }) 只綁一個管理 listener，不另開流量埠", async () => {
    app = await buildApp({
      management: { host: "127.0.0.1", port: 0 },
      idleTimeoutMs: 60_000,
    });

    expect(app.server.listening).toBe(true);
    const addrs = app.addresses();
    expect(addrs).toHaveLength(1);
    const only = addrs[0] as AddressInfo;
    expect(only.address).toBe("127.0.0.1");
    expect(only.port).toBeGreaterThan(0);
  });

  it("任意非 /api 路徑與代理樣式請求皆 404，sentinel 上游 0 次命中", async () => {
    const { origin } = await startSentinel();
    app = await buildApp({
      management: { host: "127.0.0.1", port: 0 },
      idleTimeoutMs: 60_000,
    });

    const probe = async (
      method: string,
      url: string,
      headers?: Record<string, string>,
    ) => {
      const res = await app!.inject({ method, url, headers });
      expect(res.statusCode).toBe(404);
      expect(sentinelHits).toBe(0);
    };

    await probe("GET", "/");
    await probe("GET", "/anything");
    await probe("GET", `/proxy?url=${encodeURIComponent(`${origin}/secret`)}`);
    await probe("GET", `/forward?target=${encodeURIComponent(origin)}`);
    await probe("POST", "/ingress/events", {
      "content-type": "application/json",
    });
    await probe("CONNECT", origin.replace(/^https?:\/\//, ""));
    await probe("GET", `${origin}/via-absolute-uri`);

    expect(sentinelHits).toBe(0);
  });
});
