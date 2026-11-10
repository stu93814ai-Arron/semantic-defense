import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import tls from "node:tls";
import { AlertSendError, type OutboxRow } from "../src/alert-outbox.js";
import {
  escapeSdParam, formatSyslog5424, octetFrame, parseSyslogConfig, sendSyslog, stripSyslogMsg,
} from "../src/alert-syslog.js";
import { makeSelfSigned } from "./helpers/test-tls.js";

const row = (over: Partial<OutboxRow["payload"]> = {}): OutboxRow => ({
  id: "9", audit_id: null, channel: "syslog", kind: "auto_list",
  payload: { delivery_id: "9", kind: "auto_list", entry_id: "e1", case_id: "c1", ...over },
  attempts: 0, next_attempt_at: "0", status: "pending", error_class: null, created_at: "0", delivered_at: null,
});

const envFor = (port: number, transport = "tcp") => ({
  SD_ALERT_SYSLOG_HOST: "syslog.test",
  SD_ALERT_SYSLOG_PORT: String(port),
  SD_ALERT_SYSLOG_TRANSPORT: transport,
  SD_ALERT_SYSLOG_ALLOW_CIDRS: "127.0.0.0/8",
});

const lookup = async () => [{ address: "127.0.0.1", family: 4 as const }];

async function listenTcp(onData: (buf: Buffer) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((s) => { const chunks: Buffer[] = []; s.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))); s.on("end", () => onData(Buffer.concat(chunks))); });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { port, close: () => new Promise((ok) => server.close(() => ok())) };
}

describe("parseSyslogConfig", () => {
  it("未設則關閉；udp 與非法 port／transport 在啟動時 throw", () => {
    expect(parseSyslogConfig({})).toBeNull();
    expect(() => parseSyslogConfig({ SD_ALERT_SYSLOG_HOST: "syslog.test", SD_ALERT_SYSLOG_PORT: "514", SD_ALERT_SYSLOG_TRANSPORT: "udp" })).toThrow(/TRANSPORT/);
    expect(() => parseSyslogConfig({ SD_ALERT_SYSLOG_HOST: "syslog.test", SD_ALERT_SYSLOG_PORT: "x", SD_ALERT_SYSLOG_TRANSPORT: "tcp" })).toThrow(/PORT/);
    expect(() => parseSyslogConfig({ SD_ALERT_SYSLOG_HOST: "syslog.test", SD_ALERT_SYSLOG_PORT: "514", SD_ALERT_SYSLOG_TRANSPORT: "tcp", SD_ALERT_SYSLOG_APP_NAME: "bad name" })).toThrow(/invalid/);
    expect(parseSyslogConfig({ SD_ALERT_SYSLOG_HOST: "syslog.test", SD_ALERT_SYSLOG_PORT: "6514", SD_ALERT_SYSLOG_TRANSPORT: "tls" })?.transport).toBe("tls");
  });
});

describe("RFC 5424 與 octet-counting", () => {
  it("跳脫 SD-PARAM、剝 MSG 的 CR／LF／NUL，長度以位元組計", () => {
    expect(escapeSdParam('a"b\\c]d')).toBe('a\\"b\\\\c\\]d');
    expect(stripSyslogMsg("x\r\n\0y")).toBe("xy");
    const cfg = parseSyslogConfig(envFor(1))!;
    const r = row({ entry_id: "é你好", delivery_id: 'id]"\\' });
    const ts = "2026-11-11T00:00:00.000Z";
    const msg = formatSyslog5424(cfg, r, Date.parse(ts));
    const text = msg.toString("utf8");
    expect(text.startsWith(`<133>1 ${ts} `)).toBe(true);
    expect(text).toContain(" - semantic-defense - - [alert ");
    expect(text).toContain('delivery_id="id\\]\\"\\\\"');
    expect(text).not.toMatch(/\r|\n|\0/);
    expect(text).toContain("é你好");
    const frame = octetFrame(msg);
    const sp = frame.indexOf(0x20);
    const declared = Number(frame.subarray(0, sp).toString("utf8"));
    expect(declared).toBe(msg.length);
    expect(declared).not.toBe([...msg.toString("utf8")].length);
    expect(frame.subarray(sp + 1).length).toBe(msg.length);
  });
});

describe("sendSyslog（本機 fake server）", () => {
  const closes: Array<() => Promise<void>> = [];
  afterEach(async () => { while (closes.length) await closes.pop()!(); });

  it("TCP 送出 octet-counting 框，內容不含 CR／LF", async () => {
    let done!: (b: Buffer) => void;
    const received = new Promise<Buffer>((resolve) => { done = resolve; });
    const s = await listenTcp(done);
    closes.push(s.close);
    await sendSyslog(parseSyslogConfig(envFor(s.port))!, row({ entry_id: "a\nb" }), { lookup });
    const got = await received;
    const sp = got.indexOf(0x20);
    const body = got.subarray(sp + 1);
    expect(Number(got.subarray(0, sp).toString())).toBe(body.length);
    expect(body.toString("utf8")).not.toMatch(/\r|\n|\0/);
    expect(body.toString("utf8")).toMatch(/<133>1 \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
    expect(body.toString("utf8")).toContain(" - semantic-defense - - [alert ");
    expect(body.toString("utf8")).not.toMatch(/<133>1 - /);
  });

  it("TLS 自簽或主機名不符為 tls；錯誤不含回應原文", async () => {
    const creds = makeSelfSigned("other.test");
    const server = tls.createServer({ key: creds.key, cert: creds.cert }, (sock) => sock.end());
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    closes.push(() => new Promise((ok) => server.close(() => { creds.dispose(); ok(); })));
    const ca = makeSelfSigned("syslog.test");
    closes.push(async () => { ca.dispose(); });
    try {
      await sendSyslog(parseSyslogConfig({ ...envFor(port), SD_ALERT_SYSLOG_TRANSPORT: "tls" })!, row(), { lookup, ca: ca.ca });
      throw new Error("no-throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AlertSendError);
      expect((e as AlertSendError).errorClass).toBe("tls");
      expect(String(e)).not.toMatch(/syslog\.test|BEGIN CERTIFICATE|https?:/i);
    }
  });
});
