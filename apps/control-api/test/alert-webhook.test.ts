import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { AlertSendError, type OutboxRow } from "../src/alert-outbox.js";
import { parseWebhookConfig, sendWebhook, type WebhookHooks } from "../src/alert-webhook.js";
import { makeSelfSigned, listenTls } from "./helpers/test-tls.js";

const SECRET = "s".repeat(32);
const CN = "webhook.test";
const row = (id = "7"): OutboxRow => ({
  id, audit_id: null, channel: "webhook", kind: "auto_list",
  payload: { delivery_id: id, kind: "auto_list", entry_id: "e1", case_id: "c1" },
  attempts: 0, next_attempt_at: "0", status: "pending", error_class: null, created_at: "0", delivered_at: null,
});

const lookup = (addr = "127.0.0.1", family: 4 | 6 = 4) =>
  async () => [{ address: addr, family }];

function cfg(port: number, extra: Record<string, string | undefined> = {}) {
  return parseWebhookConfig({
    SD_ALERT_WEBHOOK_URL: `https://${CN}:${port}/hook`,
    SD_ALERT_WEBHOOK_HMAC_SECRET: SECRET,
    SD_ALERT_WEBHOOK_ALLOW_CIDRS: "127.0.0.0/8",
    ...extra,
  })!;
}

const bodyOf = (r: OutboxRow) => JSON.stringify(r.payload);
const sig = (t: string, r: OutboxRow) =>
  `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${r.id}.${bodyOf(r)}`).digest("hex")}`;

describe("parseWebhookConfig", () => {
  it("未設則關閉；userinfo、非 https、短金鑰、非法 CIDR 皆 throw，訊息不含 URL", () => {
    expect(parseWebhookConfig({})).toBeNull();
    const throws = (env: Record<string, string>) => {
      try { parseWebhookConfig(env); throw new Error("no-throw"); }
      catch (e) { expect(String(e)).not.toMatch(/https?:|@|secret=/i); }
    };
    throws({ SD_ALERT_WEBHOOK_URL: "https://user:pass@example.test/h", SD_ALERT_WEBHOOK_HMAC_SECRET: SECRET });
    throws({ SD_ALERT_WEBHOOK_URL: "http://example.test/h", SD_ALERT_WEBHOOK_HMAC_SECRET: SECRET });
    throws({ SD_ALERT_WEBHOOK_URL: "https://example.test/h" });
    throws({ SD_ALERT_WEBHOOK_URL: "https://example.test/h", SD_ALERT_WEBHOOK_HMAC_SECRET: "x".repeat(31) });
    throws({ SD_ALERT_WEBHOOK_URL: "https://example.test/h", SD_ALERT_WEBHOOK_HMAC_SECRET: SECRET, SD_ALERT_WEBHOOK_ALLOW_CIDRS: "not-a-cidr" });
  });
});

describe("sendWebhook（本機 TLS fake server）", () => {
  const tls = makeSelfSigned(CN);
  const closes: Array<() => Promise<void>> = [];
  afterEach(async () => { while (closes.length) await closes.pop()!(); });
  afterAll(() => { tls.dispose(); });

  async function boot(handler: Parameters<typeof listenTls>[1]) {
    const s = await listenTls(tls, handler);
    closes.push(s.close);
    return s;
  }

  it("送出 HMAC（t.delivery_id.body）、釘住 lookup、不跟隨 3xx、超限與逾時失敗，且錯誤不含 URL", async () => {
    const got: { sig?: string; url?: string } = {};
    const s = await boot((req, res) => {
      got.sig = String(req.headers["x-sd-alert-signature"] ?? "");
      got.url = req.url;
      res.writeHead(204).end();
    });
    const r = row("42");
    const hooks: WebhookHooks = { ca: tls.ca, lookup: lookup(), now: () => 1_700_000_000_000 };
    await sendWebhook(cfg(s.port), r, hooks);
    expect(got.url).toBe("/hook");
    expect(got.sig).toBe(sig("1700000000000", r));
    const s302 = await boot((_q, res) => { res.writeHead(302, { location: "/x" }).end(); });
    await expect(sendWebhook(cfg(s302.port), r, hooks)).rejects.toMatchObject({ errorClass: "webhook_status" });
    const big = await boot((_q, res) => { res.writeHead(200); res.write("x".repeat(64 * 1024 + 1)); res.end(); });
    await expect(sendWebhook(cfg(big.port), r, hooks)).rejects.toMatchObject({ errorClass: "webhook_size" });
  });

  it("混合 DNS 任一非公網則整批拒絕；重綁時連線仍用 pin 住的位址；自簽／主機名不符為 tls", async () => {
    const r = row();
    const mixed = async () => [{ address: "64.0.113.20", family: 4 as const }, { address: "10.0.0.1", family: 4 as const }];
    await expect(sendWebhook(cfg(443, { SD_ALERT_WEBHOOK_ALLOW_CIDRS: undefined }), r, { lookup: mixed, ca: tls.ca }))
      .rejects.toMatchObject({ errorClass: "webhook_ssrf" });
    let calls = 0;
    const seen: string[] = [];
    const s = await boot((req, res) => { seen.push(String(req.headers.host)); res.writeHead(204).end(); });
    const pin = "127.0.0.1";
    const rebind = async () => { calls += 1; return [{ address: calls === 1 ? pin : "10.0.0.1", family: 4 as const }]; };
    await sendWebhook(cfg(s.port), r, { ca: tls.ca, lookup: rebind });
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toContain(CN);
    const other = makeSelfSigned("other.test");
    const bad = await listenTls(other, (_q, res) => { res.writeHead(204).end(); });
    closes.push(async () => { await bad.close(); other.dispose(); });
    await expect(sendWebhook(cfg(bad.port), r, { ca: tls.ca, lookup: lookup() })).rejects.toBeInstanceOf(AlertSendError);
    await expect(sendWebhook(cfg(bad.port), r, { ca: tls.ca, lookup: lookup() })).rejects.toMatchObject({ errorClass: "tls" });
  });

  it("HTTPS_PROXY／NODE_USE_ENV_PROXY 不走 proxy；明文 IP 字面值僅公網可過檢查", async () => {
    const r = row();
    let proxied = 0;
    const proxy = createServer((req, res) => { proxied += 1; res.writeHead(500).end(); });
    await new Promise<void>((ok) => proxy.listen(0, "127.0.0.1", ok));
    const p = proxy.address();
    const pport = typeof p === "object" && p ? p.port : 0;
    const s = await listenTls(tls, (_q, res) => { res.writeHead(204).end(); });
    closes.push(s.close);
    closes.push(() => new Promise((ok) => proxy.close(() => ok())));
    const prev = { p: process.env.HTTPS_PROXY, n: process.env.NODE_USE_ENV_PROXY };
    process.env.HTTPS_PROXY = `http://127.0.0.1:${pport}`;
    process.env.NODE_USE_ENV_PROXY = "1";
    try {
      await sendWebhook(cfg(s.port), r, { ca: tls.ca, lookup: lookup() });
    } finally {
      process.env.HTTPS_PROXY = prev.p; process.env.NODE_USE_ENV_PROXY = prev.n;
    }
    expect(proxied).toBe(0);
    await expect(sendWebhook(
      parseWebhookConfig({ SD_ALERT_WEBHOOK_URL: "https://10.0.0.1/hook", SD_ALERT_WEBHOOK_HMAC_SECRET: SECRET })!,
      r, { lookup: lookup("10.0.0.1"), ca: tls.ca },
    )).rejects.toMatchObject({ errorClass: "webhook_ssrf" });
  });
});
