import { createHmac } from "node:crypto";
import { promises as dns } from "node:dns";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { isGlobalUnicast } from "./net-scope.js";
import { AlertSendError, type OutboxRow } from "./alert-outbox.js";

export const WEBHOOK_TIMEOUT_MS = 5_000;
export const WEBHOOK_MAX_RESPONSE = 64 * 1024;

export type LookupFn = (host: string) => Promise<Array<{ address: string; family: number }>>;
export type WebhookHooks = { ca?: string; lookup?: LookupFn; now?: () => number; timeoutMs?: number };
export type WebhookConfig = { hrefHost: string; port: number; path: string; secret: string; allow: BlockList };

function throwInvalid(flag: string): never {
  throw new Error(`${flag} is invalid`);
}

function addCidr(list: BlockList, raw: string): void {
  const s = raw.trim();
  const cut = s.lastIndexOf("/");
  const addr = cut === -1 ? s : s.slice(0, cut);
  const v = isIP(addr);
  if (v === 0) throwInvalid("SD_ALERT_WEBHOOK_ALLOW_CIDRS");
  const max = v === 6 ? 128 : 32;
  const p = cut === -1 ? max : Number(s.slice(cut + 1));
  if (!Number.isInteger(p) || p < 0 || p > max) throwInvalid("SD_ALERT_WEBHOOK_ALLOW_CIDRS");
  list.addSubnet(addr, p, v === 6 ? "ipv6" : "ipv4");
}

export function parseAllowCidrs(raw: string | undefined, flag: string): BlockList {
  const list = new BlockList();
  if (!raw?.trim()) return list;
  for (const part of raw.split(",")) {
    try { addCidr(list, part); }
    catch { throw new Error(`${flag} is invalid`); }
  }
  return list;
}

export function isAllowedAlertIp(ip: string, allow: BlockList): boolean {
  const addr = ip.split("/")[0]!;
  const v = isIP(addr);
  if (v === 0) return false;
  if (isGlobalUnicast(addr)) return true;
  return allow.check(addr, v === 6 ? "ipv6" : "ipv4");
}

function parseUrl(raw: string): URL {
  if (raw.includes("@")) throwInvalid("SD_ALERT_WEBHOOK_URL");
  let u: URL;
  try { u = new URL(raw); } catch { throwInvalid("SD_ALERT_WEBHOOK_URL"); }
  if (u.protocol !== "https:" || u.username || u.password) throwInvalid("SD_ALERT_WEBHOOK_URL");
  return u;
}

/** 未設 URL 則關閉；已設則 HMAC ≥32 bytes、https、禁止 userinfo。錯誤不帶 URL。 */
export function parseWebhookConfig(env: Record<string, string | undefined> = process.env): WebhookConfig | null {
  const raw = env.SD_ALERT_WEBHOOK_URL?.trim();
  if (!raw) return null;
  const u = parseUrl(raw);
  const secret = env.SD_ALERT_WEBHOOK_HMAC_SECRET ?? "";
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("SD_ALERT_WEBHOOK_HMAC_SECRET must be at least 32 bytes");
  const port = u.port ? Number(u.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throwInvalid("SD_ALERT_WEBHOOK_URL");
  return {
    hrefHost: u.hostname, port, path: `${u.pathname}${u.search}`, secret,
    allow: parseAllowCidrs(env.SD_ALERT_WEBHOOK_ALLOW_CIDRS, "SD_ALERT_WEBHOOK_ALLOW_CIDRS"),
  };
}

export function webhookSignature(secret: string, t: string, deliveryId: string, body: string): string {
  const hex = createHmac("sha256", secret).update(`${t}.${deliveryId}.${body}`).digest("hex");
  return `t=${t},v1=${hex}`;
}

export async function defaultLookup(host: string): Promise<Array<{ address: string; family: number }>> {
  return dns.lookup(host, { all: true });
}

export async function pinHost(host: string, allow: BlockList, lookup: LookupFn, ssrfClass = "webhook_ssrf"): Promise<{ address: string; family: 4 | 6 }> {
  const v = isIP(host);
  if (v !== 0) {
    if (!isAllowedAlertIp(host, allow)) throw new AlertSendError(ssrfClass);
    return { address: host, family: v === 6 ? 6 : 4 };
  }
  let all: Array<{ address: string; family: number }>;
  try { all = await lookup(host); }
  catch { throw new AlertSendError("dns"); }
  if (all.length === 0) throw new AlertSendError("dns");
  for (const a of all) {
    if (!isAllowedAlertIp(a.address, allow)) throw new AlertSendError(ssrfClass);
  }
  const first = all[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

function errCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
}
const isTimeout = (c: string): boolean => c === "ETIMEDOUT" || c === "ETIMEOUT" || c === "ABORT_ERR";
const isTls = (c: string): boolean => c.includes("CERT") || c.includes("TLS") || c === "UNABLE_TO_VERIFY_LEAF_SIGNATURE";
const isDns = (c: string): boolean => c === "ENOTFOUND" || c === "EAI_AGAIN";
function classify(err: unknown): string {
  const code = errCode(err);
  if (isTimeout(code)) return "webhook_timeout";
  if (isTls(code)) return "tls";
  if (isDns(code)) return "dns";
  return "send_failed";
}

function readResponse(res: import("node:http").IncomingMessage, ok: () => void, fail: (e: unknown) => void): void {
  const status = res.statusCode ?? 0;
  if (status >= 300 && status < 400) { res.resume(); fail(new AlertSendError("webhook_status")); return; }
  if (status < 200 || status >= 300) { res.resume(); fail(new AlertSendError("webhook_status")); return; }
  let n = 0;
  res.on("data", (c: Buffer) => {
    n += c.length;
    if (n > WEBHOOK_MAX_RESPONSE) { res.destroy(); fail(new AlertSendError("webhook_size")); }
  });
  res.on("end", ok);
  res.on("error", fail);
}

/** 自訂 Agent，以空白 proxyEnv 隔離子行程 NODE_USE_ENV_PROXY／HTTPS_PROXY。 */
export function createWebhookAgent(ca?: string): https.Agent {
  return new https.Agent({ keepAlive: false, rejectUnauthorized: true, ca, proxyEnv: {}, autoSelectFamily: false });
}

function postPinned(cfg: WebhookConfig, body: string, header: string, pin: { address: string; family: 4 | 6 }, hooks: WebhookHooks, remain: number): Promise<void> {
  const agent = createWebhookAgent(hooks.ca);
  return new Promise<void>((resolve, reject) => {
    const fail = (e: unknown) => reject(e);
    const req = https.request({
      host: cfg.hrefHost,
      port: cfg.port,
      path: cfg.path,
      method: "POST",
      servername: cfg.hrefHost,
      rejectUnauthorized: true,
      ca: hooks.ca,
      agent,
      timeout: remain,
      lookup: ((_h, opts, cb) => {
        const all = typeof opts === "object" && opts !== null && "all" in opts && Boolean((opts as { all?: boolean }).all);
        const done = typeof opts === "function" ? opts : cb;
        if (all) (done as (e: null, a: Array<{ address: string; family: 4 | 6 }>) => void)(null, [pin]);
        else (done as (e: null, a: string, f: 4 | 6) => void)(null, pin.address, pin.family);
      }) as https.RequestOptions["lookup"],
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-sd-alert-signature": header,
      },
    }, (res) => readResponse(res, () => resolve(), fail));
    req.setTimeout(remain, () => { req.destroy(); fail(new AlertSendError("webhook_timeout")); });
    req.on("error", fail);
    req.end(body);
  }).finally(() => { if (agent !== https.globalAgent) agent.destroy(); });
}

async function postWebhook(cfg: WebhookConfig, row: OutboxRow, hooks: WebhookHooks): Promise<void> {
  const started = Date.now();
  const budget = hooks.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const pin = await pinHost(cfg.hrefHost, cfg.allow, hooks.lookup ?? defaultLookup);
  const remain = budget - (Date.now() - started);
  if (remain <= 0) throw new AlertSendError("webhook_timeout");
  const body = JSON.stringify(row.payload);
  const t = String((hooks.now ?? Date.now)());
  const header = webhookSignature(cfg.secret, t, String(row.payload.delivery_id ?? row.id), body);
  await postPinned(cfg, body, header, pin, hooks, remain);
}

/** 把 net/tls 錯誤轉成 error_class；原始 err 不出這個邊界。 */
export async function sendWebhook(cfg: WebhookConfig, row: OutboxRow, hooks: WebhookHooks = {}): Promise<void> {
  try { await postWebhook(cfg, row, hooks); }
  catch (err) {
    if (err instanceof AlertSendError) throw err;
    throw new AlertSendError(classify(err));
  }
}

export function webhookSender(cfg: WebhookConfig, hooks: WebhookHooks = {}): (row: OutboxRow) => Promise<void> {
  return (row) => sendWebhook(cfg, row, hooks);
}
