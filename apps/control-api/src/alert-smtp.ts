import net from "node:net";
import nodemailer, { type TransportOptions } from "nodemailer";
import { AlertSendError, type OutboxRow } from "./alert-outbox.js";
import { defaultLookup, parseAllowCidrs, pinHost, type LookupFn } from "./alert-webhook.js";

export const SMTP_TIMEOUT_MS = 5_000;
const MAIL_UNSAFE = /[^A-Za-z0-9._@-]/g;
const LOCAL = /^[A-Za-z0-9._%+-]+$/;
const DOMAIN = /^[A-Za-z0-9.-]+$/;

export type SmtpPin = { address: string; family: 4 | 6 };
export type SmtpHooks = { ca?: string; lookup?: LookupFn; timeoutMs?: number; signal?: AbortSignal };
export type SmtpConfig = {
  host: string; port: number; from: string; to: string;
  username?: string; password?: string;
  implicitTls: boolean; allowPlaintext: boolean;
  allow: import("node:net").BlockList;
};

function throwInvalid(flag: string): never {
  throw new Error(`${flag} is invalid`);
}

function parseAddr(raw: string | undefined, flag: string): string {
  const s = raw ?? "";
  if (/[\r\n\0]/.test(s) || /[^\x20-\x7E]/.test(s)) throwInvalid(flag);
  if (/[\s<>",]/.test(s)) throwInvalid(flag);
  const parts = s.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throwInvalid(flag);
  if (!LOCAL.test(parts[0]) || !DOMAIN.test(parts[1])) throwInvalid(flag);
  return s;
}

function parsePort(raw: string | undefined): number {
  if (!raw?.trim()) return 587;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throwInvalid("SD_ALERT_EMAIL_SMTP_PORT");
  return port;
}

function optionalCred(raw: string | undefined): string | undefined {
  const s = raw?.trim() ?? "";
  return s || undefined;
}

function parseFlag(raw: string | undefined, flag: string): boolean {
  const s = raw?.trim() ?? "";
  if (!s) return false;
  if (s === "1") return true;
  throwInvalid(flag);
}

function parseHost(raw: string | undefined): string {
  const s = raw?.trim() ?? "";
  if (!s || /[\r\n\0\s]/.test(s) || /[^\x21-\x7E]/.test(s)) throwInvalid("SD_ALERT_EMAIL_SMTP_HOST");
  return s;
}

/** 未設 TO 則關閉。明文 opt-in 時不得同時設帳密。 */
export function parseSmtpConfig(env: Record<string, string | undefined> = process.env): SmtpConfig | null {
  if (!env.SD_ALERT_EMAIL_TO?.trim()) return null;
  const allowPlaintext = parseFlag(env.SD_ALERT_SMTP_ALLOW_PLAINTEXT, "SD_ALERT_SMTP_ALLOW_PLAINTEXT");
  const username = optionalCred(env.SD_ALERT_EMAIL_USERNAME);
  const password = optionalCred(env.SD_ALERT_EMAIL_PASSWORD);
  if (allowPlaintext && (username || password)) throwInvalid("SD_ALERT_SMTP_ALLOW_PLAINTEXT");
  return {
    host: parseHost(env.SD_ALERT_EMAIL_SMTP_HOST),
    port: parsePort(env.SD_ALERT_EMAIL_SMTP_PORT),
    from: parseAddr(env.SD_ALERT_EMAIL_FROM, "SD_ALERT_EMAIL_FROM"),
    to: parseAddr(env.SD_ALERT_EMAIL_TO, "SD_ALERT_EMAIL_TO"),
    username, password,
    implicitTls: parseFlag(env.SD_ALERT_EMAIL_IMPLICIT_TLS, "SD_ALERT_EMAIL_IMPLICIT_TLS"),
    allowPlaintext,
    allow: parseAllowCidrs(env.SD_ALERT_SMTP_ALLOW_CIDRS, "SD_ALERT_SMTP_ALLOW_CIDRS"),
  };
}

export function sanitizeMailField(raw: unknown): string {
  const s = String(raw ?? "").replace(MAIL_UNSAFE, "");
  return s || "-";
}

/** 主旨與內文只由固定欄位組成；非法字元剝除，避免插入新標頭。 */
export function formatMail(row: OutboxRow): { subject: string; text: string } {
  const kind = sanitizeMailField(row.kind);
  const delivery = sanitizeMailField(row.payload.delivery_id ?? row.id);
  const entry = sanitizeMailField(row.payload.entry_id);
  const caseId = sanitizeMailField(row.payload.case_id);
  const text = [`kind=${kind}`, `delivery_id=${delivery}`, `entry_id=${entry}`, `case_id=${caseId}`, ".end"].join("\r\n");
  return { subject: `semantic-defense ${kind}`, text };
}

export function smtpTransportOptions(cfg: SmtpConfig, pin: SmtpPin, hooks: SmtpHooks): TransportOptions {
  const timeout = hooks.timeoutMs ?? SMTP_TIMEOUT_MS;
  const opts: TransportOptions = {
    host: pin.address,
    port: cfg.port,
    secure: cfg.implicitTls,
    requireTLS: !cfg.allowPlaintext && !cfg.implicitTls,
    ignoreTLS: cfg.allowPlaintext,
    tls: { servername: cfg.host, ...(hooks.ca ? { ca: hooks.ca } : {}) },
    logger: false,
    debug: false,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
  };
  if (!cfg.allowPlaintext && cfg.username) opts.auth = { user: cfg.username, pass: cfg.password ?? "" };
  return opts;
}

function errCodes(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const o = err as { code?: unknown; originalCode?: unknown };
  return `${String(o.code ?? "")} ${String(o.originalCode ?? "")}`;
}

function classify(err: unknown): string {
  const code = errCodes(err);
  if (/EAUTH/.test(code)) return "smtp_auth";
  if (/ETIMEDOUT|ETIMEOUT|ESOCKETTIMEDOUT/.test(code)) return "smtp_timeout";
  if (/CERT|TLS|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ESTARTLS/.test(code)) return "tls";
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return "dns";
  return "send_failed";
}

function throwIfAborted(signal: AbortSignal | undefined, errorClass: string): void {
  if (signal?.aborted) throw new AlertSendError(errorClass);
}

function connectPinned(pin: SmtpPin, port: number, signal?: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: pin.address, port, family: pin.family });
    const fail = (e: unknown) => { socket.destroy(); reject(e); };
    const onAbort = () => fail(new AlertSendError("smtp_timeout"));
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => { signal?.removeEventListener("abort", onAbort); resolve(socket); });
    socket.once("error", (e) => { signal?.removeEventListener("abort", onAbort); fail(e); });
  });
}

async function dispatch(cfg: SmtpConfig, row: OutboxRow, hooks: SmtpHooks): Promise<void> {
  const pin = await pinHost(cfg.host, cfg.allow, hooks.lookup ?? defaultLookup, "ssrf");
  throwIfAborted(hooks.signal, "smtp_timeout");
  const socket = await connectPinned(pin, cfg.port, hooks.signal);
  const onAbort = () => { socket.destroy(); };
  hooks.signal?.addEventListener("abort", onAbort, { once: true });
  const transport = nodemailer.createTransport({ ...smtpTransportOptions(cfg, pin, hooks), connection: socket });
  try {
    const mail = formatMail(row);
    await transport.sendMail({ from: cfg.from, to: cfg.to, subject: mail.subject, text: mail.text });
  } finally {
    hooks.signal?.removeEventListener("abort", onAbort);
    socket.destroy();
    transport.close();
  }
}

/** 把 net／tls／SMTP 錯誤轉成 error_class；原始 err 不出這個邊界。 */
export async function sendMail(cfg: SmtpConfig, row: OutboxRow, hooks: SmtpHooks = {}): Promise<void> {
  try { await dispatch(cfg, row, hooks); }
  catch (err) {
    if (err instanceof AlertSendError) throw err;
    throw new AlertSendError(classify(err));
  }
}

export function smtpSender(cfg: SmtpConfig, hooks: SmtpHooks = {}): (row: OutboxRow, opts?: { signal?: AbortSignal }) => Promise<void> {
  return (r, opts) => sendMail(cfg, r, { ...hooks, signal: opts?.signal ?? hooks.signal });
}
