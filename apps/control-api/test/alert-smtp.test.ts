import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import tls from "node:tls";
import { AlertSendError, type OutboxRow } from "../src/alert-outbox.js";
import {
  formatMail, parseSmtpConfig, sendMail, smtpTransportOptions,
} from "../src/alert-smtp.js";
import { makeSelfSigned } from "./helpers/test-tls.js";

const row = (over: Partial<OutboxRow["payload"]> = {}): OutboxRow => ({
  id: "9", audit_id: null, channel: "email", kind: "auto_list",
  payload: { delivery_id: "9", kind: "auto_list", entry_id: "e1", case_id: "c1", ...over },
  attempts: 0, next_attempt_at: "0", status: "pending", error_class: null, created_at: "0", delivered_at: null,
});

const baseEnv = (port: number) => ({
  SD_ALERT_EMAIL_TO: "ops@example.test",
  SD_ALERT_EMAIL_FROM: "alert@example.test",
  SD_ALERT_EMAIL_SMTP_HOST: "mail.test",
  SD_ALERT_EMAIL_SMTP_PORT: String(port),
  SD_ALERT_SMTP_ALLOW_CIDRS: "127.0.0.0/8",
});

const lookup = async () => [{ address: "127.0.0.1", family: 4 as const }];

type Sock = net.Socket;
type Fake = {
  port: number;
  transcript: () => string;
  data: () => string;
  close: () => Promise<void>;
};

function ehloReply(sock: Sock, starttls: boolean, auth: boolean): void {
  sock.write("250-mail.test\r\n");
  if (starttls) sock.write("250-STARTTLS\r\n");
  if (auth) sock.write("250-AUTH PLAIN LOGIN\r\n");
  sock.write("250 8BITMIME\r\n");
}

type SmtpCtx = {
  starttls: boolean; auth: boolean; creds?: { key: string; cert: string };
  transcript: { t: string }; data: { raw: string }; dataMode: { on: boolean };
  attach: (s: Sock) => void;
};

function handleHello(sock: Sock, verb: string, ctx: SmtpCtx): boolean {
  if (verb !== "EHLO" && verb !== "HELO") return false;
  ehloReply(sock, ctx.starttls, ctx.auth);
  return true;
}

function handleMailVerb(sock: Sock, verb: string, ctx: SmtpCtx): boolean {
  if (verb === "AUTH") { sock.write(ctx.auth ? "235 ok\r\n" : "503 no\r\n"); return true; }
  if (verb === "MAIL" || verb === "RCPT" || verb === "RSET" || verb === "NOOP") { sock.write("250 ok\r\n"); return true; }
  return false;
}

function handleLine(sock: Sock, line: string, ctx: SmtpCtx): void {
  ctx.transcript.t += `${line}\n`;
  const verb = line.split(" ")[0]!.toUpperCase();
  if (handleHello(sock, verb, ctx) || handleMailVerb(sock, verb, ctx)) return;
  if (verb === "STARTTLS") { beginTls(sock, ctx); return; }
  if (verb === "DATA") { sock.write("354 go\r\n"); ctx.dataMode.on = true; return; }
  if (verb === "QUIT") { sock.write("221 bye\r\n"); sock.end(); return; }
  sock.write("500 unknown\r\n");
}

function beginTls(sock: Sock, ctx: SmtpCtx): void {
  if (!ctx.starttls || !ctx.creds) { sock.write("502 no\r\n"); return; }
  sock.write("220 ready\r\n");
  sock.removeAllListeners("data");
  const secure = new tls.TLSSocket(sock, {
    isServer: true,
    secureContext: tls.createSecureContext({ key: ctx.creds.key, cert: ctx.creds.cert, minVersion: "TLSv1.2" }),
  });
  secure.on("secure", () => ctx.attach(secure));
}

function attachSock(sock: Sock, ctx: SmtpCtx): void {
  let buf = "";
  sock.on("data", (chunk: string | Buffer) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (ctx.dataMode.on) {
      ctx.data.raw += text;
      if (ctx.data.raw.includes("\r\n.\r\n")) {
        ctx.dataMode.on = false;
        sock.write("250 ok\r\n");
      }
      return;
    }
    buf += text;
    for (;;) {
      const i = buf.indexOf("\r\n");
      if (i < 0) break;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      handleLine(sock, line, ctx);
    }
  });
}

async function listenSmtp(opts: {
  starttls: boolean; auth?: boolean; implicit?: boolean; creds?: { key: string; cert: string };
}): Promise<Fake> {
  const transcript = { t: "" };
  const data = { raw: "" };
  const ctx = { starttls: opts.starttls, auth: opts.auth ?? true, creds: opts.creds, transcript, data, dataMode: { on: false }, attach: (s: Sock) => attachSock(s, ctx) };
  const onConn = (sock: Sock) => { sock.write("220 mail.test ESMTP\r\n"); attachSock(sock, ctx); };
  const server = opts.implicit && opts.creds
    ? tls.createServer({ key: opts.creds.key, cert: opts.creds.cert, minVersion: "TLSv1.2" }, onConn)
    : net.createServer(onConn);
  await new Promise<void>((ok) => { server.listen(0, "127.0.0.1", ok); });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port, transcript: () => transcript.t, data: () => data.raw,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

describe("parseSmtpConfig", () => {
  it("未設則關閉；TO／FROM 含 CRLF、顯示名稱、非 ASCII 或多個 @ 則 throw", () => {
    expect(parseSmtpConfig({})).toBeNull();
    const ok = baseEnv(587);
    expect(parseSmtpConfig(ok)?.to).toBe("ops@example.test");
    expect(() => parseSmtpConfig({ ...ok, SD_ALERT_EMAIL_TO: "ops@example.test\r\nBcc:eve@x" })).toThrow(/EMAIL_TO/);
    expect(() => parseSmtpConfig({ ...ok, SD_ALERT_EMAIL_FROM: "Alert <alert@example.test>" })).toThrow(/EMAIL_FROM/);
    expect(() => parseSmtpConfig({ ...ok, SD_ALERT_EMAIL_TO: "ops@例.test" })).toThrow(/EMAIL_TO/);
    expect(() => parseSmtpConfig({ ...ok, SD_ALERT_EMAIL_FROM: "a@b@c.test" })).toThrow(/EMAIL_FROM/);
    expect(() => parseSmtpConfig({ ...ok, SD_ALERT_SMTP_ALLOW_PLAINTEXT: "1", SD_ALERT_EMAIL_USERNAME: "u" })).toThrow(/PLAINTEXT/);
    expect(() => parseSmtpConfig({ ...ok, SD_ALERT_SMTP_ALLOW_PLAINTEXT: "1", SD_ALERT_EMAIL_PASSWORD: "p" })).toThrow(/PLAINTEXT/);
  });

  it("明文與 IMPLICIT_TLS 僅接受未設或 1，其餘值啟動即 throw", () => {
    const ok = baseEnv(587);
    expect(parseSmtpConfig(ok)).toMatchObject({ allowPlaintext: false, implicitTls: false });
    expect(parseSmtpConfig({ ...ok, SD_ALERT_SMTP_ALLOW_PLAINTEXT: "1" })?.allowPlaintext).toBe(true);
    expect(parseSmtpConfig({ ...ok, SD_ALERT_EMAIL_IMPLICIT_TLS: "1" })?.implicitTls).toBe(true);
    for (const v of ["true", "0", "yes", "TRUE", "2"]) {
      expect(() => parseSmtpConfig({ ...ok, SD_ALERT_SMTP_ALLOW_PLAINTEXT: v })).toThrow(/SD_ALERT_SMTP_ALLOW_PLAINTEXT is invalid/);
      expect(() => parseSmtpConfig({ ...ok, SD_ALERT_EMAIL_IMPLICIT_TLS: v })).toThrow(/SD_ALERT_EMAIL_IMPLICIT_TLS is invalid/);
    }
  });
});

describe("formatMail 與 transport 選項", () => {
  it("欄位含 CR／LF／NUL 或非白名單字元會被剝除，且不會產生新標頭", () => {
    const mail = formatMail(row({ entry_id: "ok\r\nBcc:eve@x", case_id: "c1\0x" }));
    expect(mail.subject).toBe("semantic-defense auto_list");
    expect(mail.subject).not.toMatch(/[\r\n\0]/);
    expect(mail.text).not.toMatch(/Bcc:/);
    expect(mail.text).not.toMatch(/\0/);
    expect(mail.text).toContain("entry_id=ok");
    expect(mail.text).toMatch(/(^|\r\n)\.end(\r\n|$)/);
  });

  it("requireTLS、servername、關閉 logger／debug，且不設 proxy 或 rejectUnauthorized=false", () => {
    const cfg = parseSmtpConfig(baseEnv(587))!;
    const opts = smtpTransportOptions(cfg, { address: "127.0.0.1", family: 4 }, {});
    expect(opts.requireTLS).toBe(true);
    expect(opts.tls?.servername).toBe("mail.test");
    expect(opts.logger).toBe(false);
    expect(opts.debug).toBe(false);
    expect(opts.proxy).toBeUndefined();
    expect(opts.tls?.rejectUnauthorized).not.toBe(false);
    expect(opts.ignoreTLS).toBeFalsy();
    const plain = parseSmtpConfig({ ...baseEnv(25), SD_ALERT_SMTP_ALLOW_PLAINTEXT: "1" })!;
    const p = smtpTransportOptions(plain, { address: "127.0.0.1", family: 4 }, {});
    expect(p.ignoreTLS).toBe(true);
    expect(p.auth).toBeUndefined();
  });
});

describe("sendMail（本機 fake SMTP）", () => {
  const closes: Array<() => Promise<void> | void> = [];
  afterEach(async () => { while (closes.length) await closes.pop()!(); });

  it("伺服器未宣告 STARTTLS 時發送失敗，且錯誤不含主機或回應原文", async () => {
    const s = await listenSmtp({ starttls: false });
    closes.push(s.close);
    try {
      await sendMail(parseSmtpConfig(baseEnv(s.port))!, row(), { lookup });
      throw new Error("no-throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AlertSendError);
      expect((e as AlertSendError).errorClass).toMatch(/tls|send_failed/);
      expect(String(e)).not.toMatch(/mail\.test|ESMTP|STARTTLS|example\.test/i);
    }
  });

  it("自簽或主機名不符的憑證視為 tls", async () => {
    const self = makeSelfSigned("mail.test");
    closes.push(self.dispose);
    const s = await listenSmtp({ starttls: true, creds: self });
    closes.push(s.close);
    try {
      await sendMail(parseSmtpConfig(baseEnv(s.port))!, row(), { lookup });
      throw new Error("no-throw");
    } catch (e) {
      expect((e as AlertSendError).errorClass).toBe("tls");
      expect(String(e)).not.toMatch(/mail\.test|BEGIN CERTIFICATE/i);
    }
    const wrong = makeSelfSigned("other.test");
    closes.push(wrong.dispose);
    const t = await listenSmtp({ starttls: true, creds: wrong });
    closes.push(t.close);
    try {
      await sendMail(parseSmtpConfig(baseEnv(t.port))!, row(), { lookup, ca: wrong.ca });
      throw new Error("no-throw");
    } catch (e) {
      expect((e as AlertSendError).errorClass).toBe("tls");
    }
  });

  it("明文 opt-in 模式從頭到尾不送 AUTH", async () => {
    const s = await listenSmtp({ starttls: false, auth: true });
    closes.push(s.close);
    const cfg = parseSmtpConfig({ ...baseEnv(s.port), SD_ALERT_SMTP_ALLOW_PLAINTEXT: "1" })!;
    await sendMail(cfg, row(), { lookup });
    expect(s.transcript().toUpperCase()).not.toMatch(/\bAUTH\b/);
  });

  it("以 . 開頭的行有做 dot-stuffing，且 DATA 以 CRLF.CRLF 結束", async () => {
    const creds = makeSelfSigned("mail.test");
    closes.push(creds.dispose);
    const s = await listenSmtp({ starttls: true, creds });
    closes.push(s.close);
    await sendMail(parseSmtpConfig(baseEnv(s.port))!, row(), { lookup, ca: creds.ca });
    const raw = s.data();
    expect(raw).toContain("\r\n..end\r\n");
    expect(raw.endsWith("\r\n.\r\n")).toBe(true);
  });
});
