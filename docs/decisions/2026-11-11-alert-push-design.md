# 2026-11-11 Alert-push design note (Asia/Taipei)

This note records the design for the proactive auto_list alert-push slice. It is not a user decision.

Already recorded in `docs/decisions/2026-11-10-allowlist-alert.md`:
- User decision (relayed by 軟體大總召): auto_list alerts must be pushed proactively, supporting all three of email, webhook and syslog, chosen at install time.
- Ruling by 軟體大總召 (PM, adopting security's advice; not confirmed by the user): looking up the audit is not enough for (c); (c) is done only once there is proactive push that has passed security review. The slice must include retry and logging for failed deliveries, and a volume alert when the breaker is near its limit. Prefer no external packages, and keep credentials out of the audit. The `blacklist.auto_list` audit row is the data foundation.

Nothing new is attributed to the user. Where a later security review or PM ruling in this note contradicts an earlier proposal here, the later text wins. PM rulings are not confirmed by the user.

## A 組領航員裁示 (2026-11-11), technical defaults; 軟體大總召 may overrule

This is a technical default from A 組領航員, not a user decision. 軟體大總召 may overrule it.

1. No IP or CIDR in the payload by default. The payload carries `entry_id` and `case_id` only; the admin looks details up in the console. Adding addresses later would be a separate opt-in.
2. HMAC is required whenever a webhook is configured. A missing key or one shorter than 32 bytes makes `buildApp` throw.
3. Volume threshold is `ceil(0.8 · N)`, with no new env var.
4. When the breaker actually opens, send one more alert per open event, deduplicated with the same once-per-window rule.
5. Plaintext SMTP only with the explicit opt-in `SD_ALERT_SMTP_ALLOW_PLAINTEXT=1`. In that mode never send AUTH, make `buildApp` throw if a username or a password is set, and log a startup warn.
6. Private-network override only as an explicit per-channel CIDR list (`SD_ALERT_WEBHOOK_ALLOW_CIDRS`, plus `SD_ALERT_SMTP_ALLOW_CIDRS` and `SD_ALERT_SYSLOG_ALLOW_CIDRS`), never a blanket switch. The resolved IP must still be pinned.
7. Retry: 8 times, starting at 1s and doubling, capped at 15 minutes.
8. Failures go to both the audit (`alert.delivery_failed`) and the health counters.
9. Delivery stays in the control-api process.
10. DKIM, other SASL mechanisms and syslog client certificates are out of scope and left to the relay.

Every payload also carries a stable `delivery_id` (the outbox row id) so receivers can dedupe. SMTP and syslog response errors are never echoed; record only `error_class`.

## Later PM rulings and security review (2026-11-11)

The following are not user decisions. Items marked as PM rulings are not confirmed by the user. Security review requirements are technical constraints on the implementation.

- **Dependency exception (PM, not confirmed by the user; security reviewed the source):** SMTP uses nodemailer, pinned to exactly `10.5.0`, with integrity in the lockfile, in its own `deps:` commit. This is the only new package. The hand-written SMTP plan is dropped. SMTP remains the last channel in the implementation order.
- **Syslog transport (PM, not confirmed by the user):** only TCP or TLS. If syslog is configured with UDP, `buildApp` throws.
- **Outbox retention (PM, not confirmed by the user):** failed rows are retained 30 days, then purged. There is a total row cap, default 10000, adjustable; when the cap is exceeded, drop the oldest rows, log only counts, and reflect this in health.
- **Health (PM, not confirmed by the user):** the health endpoint also exposes undelivered counts and the last failure time. Those fields must not contain a URL, host, or raw error text. Exhausted retries remain visible in the health counters. No alert-storm summaries for now.
- **SSRF, webhook, syslog framing, outbox lease, error masking, and HMAC input** follow the security review in the sections below. Public IP literals are allowed; ports other than 443 are allowed. A webhook URL that contains userinfo makes startup throw; the whole URL is treated as a secret.

## 1. Install-time config

Parsed at `buildApp` / process start, same fail-closed style as `SD_CRITICAL_ALLOWLIST` and `autoBreakerPerHour` (invalid, throw, no listen). Each channel is independent: if that channel's enable variable is unset or blank after trim, the channel is off. If it is set, every required companion variable must be present and valid, or startup throws.

Targets are set by install-time env only. Any future API that sets a target must apply the same checks.

| Channel | Enable (unset = off) | Required when enabled | Optional |
|---|---|---|---|
| Email | `SD_ALERT_EMAIL_TO` | `SD_ALERT_EMAIL_SMTP_HOST`, `SD_ALERT_EMAIL_FROM` | `SD_ALERT_EMAIL_SMTP_PORT` (default 587), `SD_ALERT_EMAIL_USERNAME`, `SD_ALERT_EMAIL_PASSWORD`, `SD_ALERT_EMAIL_IMPLICIT_TLS` (port 465), `SD_ALERT_SMTP_ALLOW_PLAINTEXT` (must be `1` to allow plaintext; then credentials are forbidden), `SD_ALERT_SMTP_ALLOW_CIDRS` |
| Webhook | `SD_ALERT_WEBHOOK_URL` | URL must be `https` with no userinfo; `SD_ALERT_WEBHOOK_HMAC_SECRET` (at least 32 bytes) | `SD_ALERT_WEBHOOK_ALLOW_CIDRS` |
| Syslog | `SD_ALERT_SYSLOG_HOST` | `SD_ALERT_SYSLOG_PORT`, `SD_ALERT_SYSLOG_TRANSPORT` (`tcp` or `tls` only; `udp` throws) | `SD_ALERT_SYSLOG_ALLOW_CIDRS` |

`SD_ALERT_EMAIL_TO` and `SD_ALERT_EMAIL_FROM` are strict ASCII addresses with no display name. CR, LF, NUL, non-ASCII, or more than one `@` in either makes startup throw.

Invalid host, port, URL, transport, email address, HMAC length, or a non-boolean flag throws at startup. A public IP literal is a valid host; a non-public literal is not. Ports other than 443 are allowed. All three channels may be on together, or all off (a valid install that does not push until configured). The whole webhook URL (including path and query) is a secret and is never written to logs, audit, the outbox, or errors.

## 2. Data source, outbox, and multi-instance

Source: existing `audit_events` rows with `action = 'blacklist.auto_list'` (written in the same judge tx as the blocklist insert; `detail` today is `{entry_id, ip, confidence, case_id, expires_at}`). `GET /api/audit` (platform_admin) remains the human-readable view and is unchanged.

Delivery is **at-least-once** (TCP/TLS syslog and the other channels). Sending never runs inside `runJudgeTick`'s transaction (`JUDGE_LOCK` / `AUTO_LOCK`). In that same tx, after `writeAudit`, enqueue one `alert_outbox` row per enabled channel (migration: new table `alert_outbox`, not a column on `audit_events`). If that tx rolls back, no outbox row remains. Columns: `id`, `audit_id`, `channel`, `kind` (`auto_list` / `volume` / `breaker_open`), `payload`, `attempts`, `next_attempt_at`, `status` (`pending` / `delivered` / `failed`), `error_class`, `created_at`.

The `payload` column stores only the minimal fields, with no URL and no key: `{delivery_id, kind, entry_id, case_id}` for `auto_list`, and `{delivery_id, kind}` for `volume` / `breaker_open`. `delivery_id` is the outbox row id. No IP or CIDR. The admin looks up the rest in the console. Receivers dedupe on `delivery_id`. A cursor-only scan of `audit_events` would skip retries after a crash that advanced the cursor, so the outbox is the work queue.

A delivery timer in `buildApp` (separate from the judge interval) claims due rows as follows: in a short tx, `SELECT` with `FOR UPDATE SKIP LOCKED`, push `next_attempt_at` forward as the lease, and commit. Send outside any tx. Update the status in another short tx. Never hold a lock while waiting on the network. Several control-api instances can run in parallel without a second advisory lock. A crash after a successful send but before the status update is retried once the lease expires, with the same `delivery_id`. Volume and breaker-open alerts take priority over ordinary `auto_list` alerts, even when many `auto_list` rows are retrying. `already_listed` does not write a second `blacklist.auto_list`, so enqueue is naturally once per listing.

Failed rows are retained 30 days, then purged. A total row cap (default 10000, adjustable) drops the oldest rows when exceeded; log only counts, and reflect the purge in health.

## 3. Retry and errors

Eight attempts. Exponential backoff starting at 1s, factor 2, capped at 15 minutes between attempts. After the final failure: set `status=failed`, store `attempts` and an `error_class` only (`smtp_auth`, `smtp_timeout`, `tls`, `webhook_status`, `webhook_timeout`, `webhook_ssrf`, `dns`, `syslog_timeout`, and so on). No host, URL, credential, IP, response body, or SMTP/syslog text.

Net, tls, and SMTP response errors are converted to `error_class` at the send-module boundary. Raw errors never reach logs, audit, or the outbox, including via `safeErr`. Write one `alert.delivery_failed` audit row with `{delivery_id, channel, kind, error_class, attempts}`. When retries run out, also write one error log line containing only counts.

`GET /api/health` (already platform_admin, today `{status:"ok"}`) gains counts only: `{pending, failed, delivered_1h}`, plus undelivered counts and the last failure time. Exhausted retries are visible in those counters. The body must not contain a URL, host, or raw error text.

## 4. Volume alert

The breaker is a sliding 1-hour cap of `N` `source=auto` entries (`AUTO_BREAKER_PER_HOUR`, default 50, already injectable as `autoBreakerPerHour`). The volume alert fires when the window count first reaches `ceil(0.8 * N)` (40 when N is 50; also specified at the N=1 boundary), still below the trip point (`count >= N`). It is evaluated under `AUTO_LOCK` in `breakerTripped` / the auto-list path, but only enqueued, never sent, in that tx. Dedup: at most one volume alert per window until the count drops below the threshold (same idea as `auto_suppressed` / `hit_while_listed` hourly caps); if the count drops below the threshold and later reaches it again, another alert may fire. Kind `volume`; goes to every enabled channel. When the breaker actually opens, enqueue one additional `breaker_open` alert per open event, deduplicated with the same once-per-window rule. Both kinds are claimed before ordinary `auto_list` rows.

## 5. Transports

No new dependency except the nodemailer exception below. Webhook and syslog stay hand-written in control-api.

### Webhook

`node:https` only. Certificate verification on, no redirect following. Use a custom Agent with no proxy, so `NODE_USE_ENV_PROXY`, `HTTPS_PROXY`, and `--use-env-proxy` cannot bypass the pin. The 5-second timeout is a total deadline covering connect, TLS, and response. Responses over 64 KiB are truncated and counted as failure.

Pin the IP through `https.request`'s `lookup` option, keeping the original host as `servername` and for certificate verification. Never connect to the IP directly with a Host header. After DNS, check every A and AAAA record; if any one is not public (and not in `SD_ALERT_WEBHOOK_ALLOW_CIDRS`), reject the whole resolution (do not pick a public record from a mixed set). Re-check after every resolution; do not cache a pinned IP past a short TTL. A hostname mismatch or a self-signed certificate fails.

For IPv6 with an embedded v4 address (`::ffff:0:0/96`, `64:ff9b::/96`, `64:ff9b:1::/48`, `2002::/16`), extract the v4 and judge it by the v4 rules. Also exclude `fec0::/10`. This B5 leftover fix is the first code commit, with tests and a mutation. Public IP literals are allowed; private, reserved, or embedded-private literals are rejected. Ports other than 443 are allowed.

HMAC is required (header `X-SD-Alert-Signature: t=<unix_ms>,v1=<hex>`, HMAC-SHA256 of `t + "." + delivery_id + "." + raw_body`). A retry keeps the same `delivery_id` but uses a new `t`. Advise receivers to accept a ±5-minute window and dedupe by `delivery_id` within that window. A missing or short secret throws at startup. The secret never appears in logs, audit, the outbox, or errors.

### Syslog

RFC 5424 over TCP or TLS only. If the transport is UDP, `buildApp` throws. TCP/TLS framing is RFC 6587 octet-counting, which counts bytes, not characters. TLS verifies the certificate and sets `servername`; a self-signed certificate or a hostname mismatch fails. Escape `"`, `\`, and `]` in SD-PARAM values. HOSTNAME and APP-NAME are PRINTUSASCII only. Strip CR, LF, and NUL from MSG. Response errors are never echoed; only `error_class` is recorded.

SMTP and syslog hosts use the same resolve-all-records, embedded-v4, per-channel allow-CIDR, and IP-pin rules as the webhook (TLS SNI stays the original hostname).

### Email (nodemailer 10.5.0 only)

The hand-written SMTP plan is dropped. Use nodemailer pinned to exactly `10.5.0`, with integrity in the lockfile, in its own `deps:` commit. SMTP is the last channel in the implementation order.

Set `requireTLS: true` and `tls.servername`. Never set `tls.rejectUnauthorized` to false; certificate verification stays on. STARTTLS and implicit TLS both verify the certificate and set `servername`. A self-signed certificate or a hostname mismatch fails. A server that does not advertise STARTTLS fails; there is no plaintext downgrade unless the explicit opt-in below is set. Turn off `logger` and `debug`. Do not set `proxy`.

Plaintext is refused unless `SD_ALERT_SMTP_ALLOW_PLAINTEXT=1`. In that mode set `ignoreTLS`, never supply auth, never send AUTH, make `buildApp` throw if a username or a password is set, and log a startup warn.

Build the subject and body only from fixed fields, using a character whitelist. Values that contain CR, LF, NUL, or a character outside the whitelist are rejected or stripped so they cannot create a new header line. Dot-stuffing and SMTP reply parsing are left to the package and confirmed with local fake-server integration tests. SMTP response errors are converted to `error_class` at the send-module boundary and are never echoed.

Out of scope and left to the relay (A 組領航員裁示): DKIM/SPF signing, SASL beyond PLAIN/LOGIN, and syslog client certificates.

## 6. Credentials

Read from env only. Never written to `audit_events`, logs, error objects, or the outbox payload (same rule as PLAN.md and `safeErr`: no secrets, no SMTP passwords, no webhook userinfo or URL). Webhook HMAC is required whenever `SD_ALERT_WEBHOOK_URL` is set. The secret must be at least 32 bytes.

## 7. Commit breakdown

Each commit is at most 400 lines, red then green. `package.json` / the lockfile change only in the nodemailer `deps:` commit, and only for that pin.

1. B5 leftover: embedded v4 plus `fec0::/10`, with tests and a mutation (first code commit).
2. `deps:` pin nodemailer to exactly `10.5.0` with lockfile integrity.
3. `alert_outbox` migration, enqueue from `blacklist.auto_list` in the same tx, lease claim with `SKIP LOCKED`, retry, `alert.delivery_failed`, health, retention.
4. Webhook.
5. Syslog (TCP/TLS).
6. SMTP via nodemailer (last channel).
7. Volume and breaker-open alerts.
8. Docs (`deploy-checklist`).

## 8. Open / residual

Residual for A 組領航員: section 2 of the security test list (`/workspace/exec-a-logs/push-design-tests.md`) still describes hand-written SMTP protocol tests (re-EHLO after STARTTLS, no pipelining, line-length and total-size caps, CRLF.CRLF). This design uses nodemailer 10.5.0 instead; those protocol details are left to the package and to the integration tests in section 9. The test list itself is unchanged and is not part of this repository.

Adding an IP or CIDR to the payload remains a later opt-in. There are no alert-storm summaries for now. 軟體大總召 may overrule any 領航員 default or the PM items above (the latter are not confirmed by the user).
