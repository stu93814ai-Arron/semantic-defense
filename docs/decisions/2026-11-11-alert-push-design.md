# 2026-11-11 Alert-push design note (Asia/Taipei)

This is a design proposal for the proactive auto_list alert-push slice. It is not a ruling and not a user decision.

Already recorded in `docs/decisions/2026-11-10-allowlist-alert.md`:
- User decision (relayed by 軟體大總召): auto_list alerts must be pushed proactively, supporting all three of email, webhook and syslog, chosen at install time.
- Ruling by 軟體大總召 (PM, adopting security's advice; not confirmed by the user): looking up the audit is not enough for (c); (c) is done only once there is proactive push that has passed security review. The slice must include retry and logging for failed deliveries, and a volume alert when the breaker is near its limit. Prefer no external packages, and keep credentials out of the audit. The `blacklist.auto_list` audit row is the data foundation.

The original body of this note was a proposal for 軟體大總召 and A 組領航員 to accept or amend. Nothing new is attributed to the user.

## A 組領航員裁示 (2026-11-11), technical defaults; 軟體大總召 may overrule

This is a technical default from A 組領航員, not a user decision. 軟體大總召 may overrule it.

1. No IP or CIDR in the payload by default. The payload carries `entry_id` and `case_id` only; the admin looks details up in the console. Adding addresses later would be a separate opt-in.
2. HMAC is required whenever a webhook is configured. A missing key or one shorter than 32 bytes makes `buildApp` throw.
3. Volume threshold is `ceil(0.8 · N)`, with no new env var.
4. When the breaker actually opens, send one more alert per open event, deduplicated with the same once-per-window rule.
5. Plaintext SMTP only with the explicit opt-in `SD_ALERT_SMTP_ALLOW_PLAINTEXT=1`. In that mode never send AUTH, make `buildApp` throw if credentials are set, and log a startup warn.
6. Private-network override only as an explicit per-channel CIDR list (`SD_ALERT_WEBHOOK_ALLOW_CIDRS`, plus `SD_ALERT_SMTP_ALLOW_CIDRS` and `SD_ALERT_SYSLOG_ALLOW_CIDRS`), never a blanket switch. The resolved IP must still be pinned.
7. Retry: 8 times, starting at 1s and doubling, capped at 15 minutes.
8. Failures go to both the audit (`alert.delivery_failed`) and the health counters.
9. Delivery stays in the control-api process.
10. DKIM, other SASL mechanisms and syslog client certificates are out of scope and left to the relay.

Every payload also carries a stable `delivery_id` (the outbox row id) so receivers can dedupe. SMTP and syslog response errors are never echoed; record only `error_class`.

The sections below are updated to match those defaults. The ten open questions in the first draft are closed by this ruling unless 軟體大總召 overrules them.

## 1. Install-time config

Parsed at `buildApp` / process start, same fail-closed style as `SD_CRITICAL_ALLOWLIST` and `autoBreakerPerHour` (invalid, throw, no listen). Each channel is independent: if that channel's enable variable is unset or blank after trim, the channel is off. If it is set, every required companion variable must be present and valid, or startup throws.

| Channel | Enable (unset = off) | Required when enabled | Optional |
|---|---|---|---|
| Email | `SD_ALERT_EMAIL_TO` | `SD_ALERT_EMAIL_SMTP_HOST`, `SD_ALERT_EMAIL_FROM` | `SD_ALERT_EMAIL_SMTP_PORT` (default 587), `SD_ALERT_EMAIL_USERNAME`, `SD_ALERT_EMAIL_PASSWORD`, `SD_ALERT_EMAIL_IMPLICIT_TLS` (port 465), `SD_ALERT_SMTP_ALLOW_PLAINTEXT` (must be `1` to allow plaintext; then credentials are forbidden), `SD_ALERT_SMTP_ALLOW_CIDRS` |
| Webhook | `SD_ALERT_WEBHOOK_URL` | URL must be `https`; `SD_ALERT_WEBHOOK_HMAC_SECRET` (at least 32 bytes) | `SD_ALERT_WEBHOOK_ALLOW_CIDRS` |
| Syslog | `SD_ALERT_SYSLOG_HOST` | `SD_ALERT_SYSLOG_PORT`, `SD_ALERT_SYSLOG_TRANSPORT` (`udp` / `tcp` / `tls`) | `SD_ALERT_SYSLOG_ALLOW_CIDRS` |

Invalid host, port, URL, transport, email address, HMAC length, or a non-boolean flag throws at startup. All three channels may be on together, or all off (a valid install that does not push until configured).

## 2. Data source, outbox, and multi-instance

Source: existing `audit_events` rows with `action = 'blacklist.auto_list'` (written in the same judge tx as the blocklist insert; `detail` today is `{entry_id, ip, confidence, case_id, expires_at}`). `GET /api/audit` (platform_admin) remains the human-readable view and is unchanged.

Delivery is **at-least-once**. Sending never runs inside `runJudgeTick`'s transaction (`JUDGE_LOCK` / `AUTO_LOCK`). In that same tx, after `writeAudit`, enqueue one `alert_outbox` row per enabled channel (migration: new table `alert_outbox`, not a column on `audit_events`). Columns: `id`, `audit_id`, `channel`, `kind` (`auto_list` / `volume` / `breaker_open`), `attempts`, `next_attempt_at`, `status` (`pending` / `delivered` / `failed`), `error_class`, `created_at`.

Default payload: `{delivery_id, kind, entry_id, case_id}` for `auto_list` (`delivery_id` is the outbox row id; no IP or CIDR) and `{delivery_id, kind}` for volume / breaker-open alerts. The admin looks up the rest in the console. A cursor-only scan of `audit_events` would skip retries after a crash that advanced the cursor, so the outbox is the work queue.

A delivery timer in `buildApp` (separate from the judge interval) claims due rows with `FOR UPDATE SKIP LOCKED` and sends them. Several control-api instances can run in parallel without a second advisory lock. A crash after a successful send but before the status update can produce one duplicate; receivers may deduplicate on `delivery_id`. `already_listed` does not write a second `blacklist.auto_list`, so enqueue is naturally once per listing.

## 3. Retry

Eight attempts. Exponential backoff starting at 1s, factor 2, capped at 15 minutes between attempts. After the final failure: set `status=failed`, store `attempts` and an `error_class` only (`smtp_auth`, `smtp_timeout`, `tls`, `webhook_status`, `webhook_timeout`, `webhook_ssrf`, `dns`, `syslog_timeout`, and so on). No host, URL, credential, IP, response body, or SMTP/syslog text. Write one `alert.delivery_failed` audit row with `{delivery_id, channel, kind, error_class, attempts}`. `GET /api/health` (already platform_admin, today `{status:"ok"}`) gains counts only: `{pending, failed, delivered_1h}`.

## 4. Volume alert

The breaker is a sliding 1-hour cap of `N` `source=auto` entries (`AUTO_BREAKER_PER_HOUR`, default 50, already injectable as `autoBreakerPerHour`). The volume alert fires when the window count first reaches `ceil(0.8 * N)` (40 when N is 50), still below the trip point (`count >= N`). It is evaluated under `AUTO_LOCK` in `breakerTripped` / the auto-list path, but only enqueued, never sent, in that tx. Dedup: at most one volume alert per window until the count drops below the threshold (same idea as `auto_suppressed` / `hit_while_listed` hourly caps). Kind `volume`; goes to every enabled channel. When the breaker actually opens, enqueue one additional `breaker_open` alert per open event, deduplicated with the same once-per-window rule.

## 5. No external packages

No new dependency. All three transports are hand-written in control-api.

- **Email:** SMTP on `node:net` / `node:tls`. STARTTLS is required on the submission port; implicit TLS (SMTPS) is allowed when `SD_ALERT_EMAIL_IMPLICIT_TLS` is set. Plaintext is refused unless `SD_ALERT_SMTP_ALLOW_PLAINTEXT=1`. In that mode AUTH is never sent, `buildApp` throws if credentials are set, and a startup warn is logged. Otherwise AUTH is `PLAIN` or `LOGIN`, and only after TLS is up. SMTP response text is never logged or stored, only `error_class`.
- **Webhook:** `node:https` only. Certificate verification on, no redirect following, 5s timeout, 64 KiB response size limit. HMAC is required (header `X-SD-Alert-Signature: t=<unix_ms>,v1=<hex>`, HMAC-SHA256 of `t + "." + raw_body`, 5-minute replay window). A missing or short secret throws at startup.
- **Syslog:** RFC 5424 over UDP, TCP, or TLS. TCP/TLS framing is RFC 6587 octet-counting. Response errors are never echoed; only `error_class` is recorded.

Out of scope and left to the relay (A 組領航員裁示): DKIM/SPF signing, SASL beyond PLAIN/LOGIN, and syslog client certificates.

## 6. Credentials

Read from env only. Never written to `audit_events`, logs, or error objects (same rule as PLAN.md and `safeErr`: no secrets, no SMTP passwords, no webhook userinfo). Webhook HMAC is required whenever `SD_ALERT_WEBHOOK_URL` is set. The secret must be at least 32 bytes.

## 7. SSRF

Webhook, syslog and SMTP hosts are resolved, then checked with the existing B5 `isGlobalUnicast` ranges (private, loopback, link-local, reserved, documentation, multicast). The connect pins that resolved address (TLS SNI stays the original hostname). Default: refuse those ranges. Override is only an explicit per-channel CIDR list (`SD_ALERT_WEBHOOK_ALLOW_CIDRS`, `SD_ALERT_SMTP_ALLOW_CIDRS`, `SD_ALERT_SYSLOG_ALLOW_CIDRS`), never a blanket switch. The resolved IP must still be pinned. Re-check after every resolution; do not cache a pinned IP past a short TTL.

## 8. Payload minimisation

Default payload: `{delivery_id, kind, entry_id, case_id}` for `auto_list`, and `{delivery_id, kind}` for `volume` / `breaker_open`. No IP or CIDR. The admin looks up the rest in the console (`GET /api/audit`). Adding addresses would be a separate opt-in. Logs and `alert.delivery_failed` never include an IP, CIDR, credential, or raw SMTP/syslog text; only `error_class` (and `channel`, `kind`, `attempts`, `delivery_id`).

## 9. Commit breakdown

Each commit is at most 400 lines, red then green, no package.json / lockfile changes. Roughly: (1) `alert_outbox` migration, enqueue from `blacklist.auto_list`, delivery loop plus `SKIP LOCKED`, retry, `alert.delivery_failed`, health counts; (2) webhook; (3) SMTP connection/TLS; (4) SMTP AUTH and send; (5) syslog; (6) volume and breaker-open alerts; (7) docs (`deploy-checklist`).

## 10. Open questions

The ten questions in the first draft of this note were closed by the 2026-11-11 領航員 defaults above. Residual items, if any, wait for 軟體大總召 to overrule or for a later opt-in (for example, putting a CIDR in the payload).
