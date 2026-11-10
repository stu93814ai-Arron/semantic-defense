import net from "node:net";
import tls from "node:tls";
import { AlertSendError, type OutboxRow } from "./alert-outbox.js";
import { defaultLookup, parseAllowCidrs, pinHost, type LookupFn } from "./alert-webhook.js";

export const SYSLOG_TIMEOUT_MS = 5_000;
const PRINTUSASCII = /^[\x21-\x7E]+$/;

export type SyslogTransport = "tcp" | "tls";
export type SyslogConfig = {
  host: string; port: number; transport: SyslogTransport;
  hostname: string; appName: string; allow: import("node:net").BlockList;
};
export type SyslogHooks = { ca?: string; lookup?: LookupFn; timeoutMs?: number; now?: () => number; signal?: AbortSignal };

function throwInvalid(flag: string): never {
  throw new Error(`${flag} is invalid`);
}

function printusa(raw: string | undefined, fallback: string, flag: string): string {
  const s = raw?.trim() || fallback;
  if (!PRINTUSASCII.test(s)) throwInvalid(flag);
  return s;
}

function parseTransport(raw: string | undefined): SyslogTransport {
  const transport = (raw ?? "").trim().toLowerCase();
  if (transport === "tcp" || transport === "tls") return transport;
  throwInvalid("SD_ALERT_SYSLOG_TRANSPORT");
}

function parsePort(raw: string | undefined): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throwInvalid("SD_ALERT_SYSLOG_PORT");
  return port;
}

/** 未設 HOST 則關閉。transport 僅 tcp／tls；udp 或其它值一律 throw。 */
export function parseSyslogConfig(env: Record<string, string | undefined> = process.env): SyslogConfig | null {
  const host = env.SD_ALERT_SYSLOG_HOST?.trim();
  if (!host) return null;
  return {
    host, port: parsePort(env.SD_ALERT_SYSLOG_PORT), transport: parseTransport(env.SD_ALERT_SYSLOG_TRANSPORT),
    hostname: printusa(env.SD_ALERT_SYSLOG_HOSTNAME, "-", "SD_ALERT_SYSLOG_HOSTNAME"),
    appName: printusa(env.SD_ALERT_SYSLOG_APP_NAME, "semantic-defense", "SD_ALERT_SYSLOG_APP_NAME"),
    allow: parseAllowCidrs(env.SD_ALERT_SYSLOG_ALLOW_CIDRS, "SD_ALERT_SYSLOG_ALLOW_CIDRS"),
  };
}

export function escapeSdParam(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/]/g, "\\]");
}

export function stripSyslogMsg(value: string): string {
  return value.replace(/[\r\n\0]/g, "");
}

/** RFC 5424 訊息（不含 octet-counting 前綴）。TIMESTAMP 為 RFC 3339 UTC；PROCID／MSGID 為 NILVALUE。 */
export function formatSyslog5424(cfg: SyslogConfig, row: OutboxRow, now: number = Date.now()): Buffer {
  const ts = new Date(now).toISOString();
  const delivery = escapeSdParam(String(row.payload.delivery_id ?? row.id));
  const kind = escapeSdParam(row.kind);
  const msg = stripSyslogMsg(JSON.stringify(row.payload));
  const sd = `[alert delivery_id="${delivery}" kind="${kind}"]`;
  return Buffer.from(`<133>1 ${ts} ${cfg.hostname} ${cfg.appName} - - ${sd} ${msg}`, "utf8");
}

export function octetFrame(msg: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${msg.length} `, "utf8"), msg]);
}

function errCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
}
function classify(err: unknown): string {
  const code = errCode(err);
  if (code === "ETIMEDOUT" || code === "ETIMEOUT") return "syslog_timeout";
  if (code.includes("CERT") || code.includes("TLS") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return "tls";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  return "send_failed";
}

function bindAbort(signal: AbortSignal | undefined, destroy: () => void): () => void {
  if (!signal) return () => {};
  const on = () => destroy();
  if (signal.aborted) { on(); return () => {}; }
  signal.addEventListener("abort", on, { once: true });
  return () => signal.removeEventListener("abort", on);
}

function connectTcp(address: string, port: number, family: 4 | 6, remain: number, signal?: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: address, port, family });
    const unbind = bindAbort(signal, () => { s.destroy(); reject(new AlertSendError("syslog_timeout")); });
    const fail = (e: unknown) => { unbind(); s.destroy(); reject(e); };
    s.setTimeout(remain, () => fail(new AlertSendError("syslog_timeout")));
    s.once("connect", () => { unbind(); resolve(s); });
    s.once("error", fail);
  });
}

function wrapTls(socket: net.Socket, servername: string, remain: number, ca?: string, signal?: AbortSignal): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket, servername, rejectUnauthorized: true, ca });
    const unbind = bindAbort(signal, () => { t.destroy(); reject(new AlertSendError("syslog_timeout")); });
    const fail = (e: unknown) => { unbind(); t.destroy(); reject(e); };
    t.setTimeout(remain, () => fail(new AlertSendError("syslog_timeout")));
    t.once("secureConnect", () => { unbind(); resolve(t); });
    t.once("error", fail);
  });
}

async function writeAndClose(socket: net.Socket, frame: Buffer, remain: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const unbind = bindAbort(signal, () => { socket.destroy(); reject(new AlertSendError("syslog_timeout")); });
    const fail = (e: unknown) => { unbind(); socket.destroy(); reject(e); };
    socket.setTimeout(remain, () => fail(new AlertSendError("syslog_timeout")));
    socket.once("error", fail);
    socket.end(frame, () => { unbind(); resolve(); });
  });
}

async function postSyslog(cfg: SyslogConfig, row: OutboxRow, hooks: SyslogHooks): Promise<void> {
  const started = Date.now();
  const budget = hooks.timeoutMs ?? SYSLOG_TIMEOUT_MS;
  const pin = await pinHost(cfg.host, cfg.allow, hooks.lookup ?? defaultLookup, "ssrf");
  const remain = budget - (Date.now() - started);
  if (remain <= 0 || hooks.signal?.aborted) throw new AlertSendError("syslog_timeout");
  const frame = octetFrame(formatSyslog5424(cfg, row, hooks.now?.() ?? Date.now()));
  const sock = await connectTcp(pin.address, cfg.port, pin.family, remain, hooks.signal);
  const unbind = bindAbort(hooks.signal, () => sock.destroy());
  try {
    const out = cfg.transport === "tls" ? await wrapTls(sock, cfg.host, remain, hooks.ca, hooks.signal) : sock;
    await writeAndClose(out, frame, remain, hooks.signal);
  } finally {
    unbind();
  }
}

export async function sendSyslog(cfg: SyslogConfig, row: OutboxRow, hooks: SyslogHooks = {}): Promise<void> {
  try { await postSyslog(cfg, row, hooks); }
  catch (err) {
    if (err instanceof AlertSendError) throw err;
    throw new AlertSendError(classify(err));
  }
}

export function syslogSender(cfg: SyslogConfig, hooks: SyslogHooks = {}): (row: OutboxRow, opts?: { signal?: AbortSignal }) => Promise<void> {
  return (row, opts) => sendSyslog(cfg, row, { ...hooks, signal: opts?.signal ?? hooks.signal });
}
