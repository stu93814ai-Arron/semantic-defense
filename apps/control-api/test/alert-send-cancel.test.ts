import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { deliverDueAlerts, enqueueAlerts } from "../src/alert-outbox.js";
import { parseSmtpConfig, smtpSender } from "../src/alert-smtp.js";
import { parseSyslogConfig, syslogSender } from "../src/alert-syslog.js";
import { buildApp, seedPhase2Fixtures, type ControlApi } from "./helpers/app.js";
import { requireDatabaseUrl } from "./helpers/pg.js";

let app: ControlApi;
afterEach(async () => { if (app) await app.close(); });
const NOW = Date.parse("2026-11-11T00:00:00Z");
const lookup = async () => [{ address: "127.0.0.1", family: 4 as const }];

async function boot(): Promise<ControlApi> {
  app = await buildApp({ idleTimeoutMs: 60_000, databaseUrl: requireDatabaseUrl(), now: () => NOW, alertDeliverIntervalMs: 0 });
  await seedPhase2Fixtures(app);
  return app;
}

function listenHang(greet?: Buffer): Promise<{ port: number; closed: Promise<void>; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    let closed!: () => void;
    const done = new Promise<void>((ok) => { closed = ok; });
    const socks = new Set<net.Socket>();
    const server = net.createServer((sock) => {
      socks.add(sock);
      if (greet) sock.write(greet);
      sock.resume();
      sock.on("close", () => { socks.delete(sock); closed(); });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port, closed: done,
        close: () => new Promise((ok) => {
          for (const s of socks) s.destroy();
          server.close(() => ok());
        }),
      });
    });
  });
}

async function closedSoon(closed: Promise<void>, slackMs: number): Promise<boolean> {
  return Promise.race([closed.then(() => true), new Promise<boolean>((ok) => setTimeout(() => ok(false), slackMs))]);
}

describe("發送期限到期後關閉底層連線", () => {
  const closes: Array<() => Promise<void>> = [];
  afterEach(async () => { while (closes.length) await closes.pop()!(); });

  it("SMTP：期限到後 fake server 看到 socket 關閉", async () => {
    await boot();
    const s = await listenHang(Buffer.from("220 mail.test ESMTP\r\n"));
    closes.push(s.close);
    await app.db.tx((q) => enqueueAlerts(q, { channels: ["email"], kind: "auto_list", now: NOW, entryId: "e1", caseId: "c1" }));
    const cfg = parseSmtpConfig({
      SD_ALERT_EMAIL_TO: "ops@example.test",
      SD_ALERT_EMAIL_FROM: "alert@example.test",
      SD_ALERT_EMAIL_SMTP_HOST: "mail.test",
      SD_ALERT_EMAIL_SMTP_PORT: String(s.port),
      SD_ALERT_SMTP_ALLOW_PLAINTEXT: "1",
      SD_ALERT_SMTP_ALLOW_CIDRS: "127.0.0.0/8",
    })!;
    await deliverDueAlerts(app.db, NOW, { email: smtpSender(cfg, { lookup, timeoutMs: 30_000 }) }, undefined, {
      sendDeadlineMs: 200, clock: () => NOW,
    });
    expect(await closedSoon(s.closed, 800)).toBe(true);
  }, 5_000);

  it("syslog：期限到後 fake server 看到 socket 關閉", async () => {
    await boot();
    const s = await listenHang();
    closes.push(s.close);
    await app.db.tx((q) => enqueueAlerts(q, { channels: ["syslog"], kind: "auto_list", now: NOW, entryId: "e1", caseId: "c1" }));
    const cfg = parseSyslogConfig({
      SD_ALERT_SYSLOG_HOST: "syslog.test",
      SD_ALERT_SYSLOG_PORT: String(s.port),
      SD_ALERT_SYSLOG_TRANSPORT: "tls",
      SD_ALERT_SYSLOG_ALLOW_CIDRS: "127.0.0.0/8",
    })!;
    await deliverDueAlerts(app.db, NOW, { syslog: syslogSender(cfg, { lookup, timeoutMs: 30_000 }) }, undefined, {
      sendDeadlineMs: 200, clock: () => NOW,
    });
    expect(await closedSoon(s.closed, 800)).toBe(true);
  }, 5_000);
});
