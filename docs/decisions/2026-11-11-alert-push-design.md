# 2026-11-11 Alert-push design note (Asia/Taipei)

This is a design proposal for the proactive auto_list alert-push slice. It is not a ruling and not a user decision.

Already recorded in `docs/decisions/2026-11-10-allowlist-alert.md`:
- User decision (relayed by 軟體大總召): auto_list alerts must be pushed proactively, supporting all three of email, webhook and syslog, chosen at install time.
- Ruling by 軟體大總召 (PM, adopting security's advice; not confirmed by the user): looking up the audit is not enough for (c); (c) is done only once there is proactive push that has passed security review. The slice must include retry and logging for failed deliveries, and a volume alert when the breaker is near its limit. Prefer no external packages, and keep credentials out of the audit. The `blacklist.auto_list` audit row is the data foundation.

The points below are for 軟體大總召 and A 組領航員 to accept or amend. Nothing new is attributed to the user.

## 1. Install-time config

Parsed at `buildApp` / process start, same fail-closed style as `SD_CRITICAL_ALLOWLIST` and `autoBreakerPerHour` (invalid → throw, no listen). Each channel is independent: if that channel's enable variable is unset or blank after trim, the channel is off. If it is set, every required companion variable must be present and valid, or startup throws.

| Channel | Enable (unset = off) | Required when enabled | Optional |
|---|---|---|---|
| Email | `SD_ALERT_EMAIL_TO` | `SD_ALERT_EMAIL_SMTP_HOST`, `SD_ALERT_EMAIL_FROM` | `SD_ALERT_EMAIL_SMTP_PORT` (default 587), `SD_ALERT_EMAIL_USERNAME`, `SD_ALERT_EMAIL_PASSWORD`, `SD_ALERT_EMAIL_IMPLICIT_TLS` (port 465), `SD_ALERT_EMAIL_ALLOW_PLAINTEXT` (default off) |
| Webhook | `SD_ALERT_WEBHOOK_URL` | URL must be `https` | `SD_ALERT_WEBHOOK_HMAC_SECRET`, `SD_ALERT_WEBHOOK_ALLOW_PRIVATE` |
| Syslog | `SD_ALERT_SYSLOG_HOST` | `SD_ALERT_SYSLOG_PORT`, `SD_ALERT_SYSLOG_TRANSPORT` (`udp` / `tcp` / `tls`) | `SD_ALERT_SYSLOG_ALLOW_PRIVATE` |

Invalid host, port, URL, transport, email address, or a non-boolean flag throws at startup. All three channels may be on together, or all off (a valid install that does not push until configured).

## 2. Data source, outbox, and multi-instance

Source: existing `audit_events` rows with `action = 'blacklist.auto_list'` (written in the same judge tx as the blocklist insert; `detail` today is `{entry_id, ip, confidence, case_id, expires_at}`). `GET /api/audit` (platform_admin) remains the human-readable view and is unchanged.

Delivery is **at-least-once**. Sending never runs inside `runJudgeTick`'s transaction (`JUDGE_LOCK` / `AUTO_LOCK`). In that same tx, after `writeAudit`, enqueue one `alert_outbox` row per enabled channel (migration: new table `alert_outbox`, not a column on `audit_events`). Columns: `id`, `audit_id`, `channel`, `kind` (`auto_list` / `volume`), `attempts`, `next_attempt_at`, `status` (`pending` / `delivered` / `failed`), `error_class`, `created_at`. Payload is taken from the audit `detail` at enqueue time (plus `hit_count` from the open case if present). A cursor-only scan of `audit_events` would skip retries after a crash that advanced the cursor, so the outbox is the work queue.

A delivery timer in `buildApp` (separate from the judge interval) claims due rows with `FOR UPDATE SKIP LOCKED` and sends them. Several control-api instances can run in parallel without a second advisory lock. A crash after a successful send but before the status update can produce one duplicate; receivers may deduplicate on `audit_id` + `channel` (webhook HMAC timestamp also helps). `already_listed` does not write a second `blacklist.auto_list`, so enqueue is naturally once per listing.

## 3. Retry

Eight attempts. Exponential backoff starting at 1s, factor 2, capped at 15 minutes between attempts. After the final failure: set `status=failed`, store `attempts` and an `error_class` only (`smtp_auth`, `smtp_timeout`, `tls`, `webhook_status`, `webhook_timeout`, `webhook_ssrf`, `dns`, `syslog_timeout`, …). No host, URL, credential, IP, response body, or SMTP text. Write one `alert.delivery_failed` audit row with `{channel, kind, error_class, attempts}`. `GET /api/health` (already platform_admin, today `{status:"ok"}`) gains counts only: `{pending, failed, delivered_1h}`.

## 4. Volume alert

The breaker is a sliding 1-hour cap of `N` `source=auto` entries (`AUTO_BREAKER_PER_HOUR`, default 50, already injectable as `autoBreakerPerHour`). The volume alert fires when the window count first reaches `ceil(0.8 * N)` (40 when N is 50), still below the trip point (`count >= N`). It is evaluated under `AUTO_LOCK` in `breakerTripped` / the auto-list path, but only enqueued, never sent, in that tx. Dedup: at most one volume alert per window until the count drops below the threshold (same idea as `auto_suppressed` / `hit_while_listed` hourly caps). Kind `volume`; goes to every enabled channel.

## 5. No external packages

No new dependency. All three transports are hand-written in control-api.

- **Email:** SMTP on `node:net` / `node:tls`. STARTTLS is required on the submission port; implicit TLS (SMTPS) is allowed when `SD_ALERT_EMAIL_IMPLICIT_TLS` is set. Plaintext is refused unless `SD_ALERT_EMAIL_ALLOW_PLAINTEXT` is explicitly true (open question whether that opt-in should exist at all). AUTH is `PLAIN` or `LOGIN`, and only after TLS is up.
- **Webhook:** `node:https` only. Certificate verification on, no redirect following, 5s timeout, 64 KiB response size limit.
- **Syslog:** RFC 5424 over UDP, TCP, or TLS. TCP/TLS framing is RFC 6587 octet-counting.

Genuinely too risky to build ourselves (open questions, still no dependency): DKIM/SPF signing (leave unsigned and let a mail relay sign); SASL beyond PLAIN/LOGIN (e.g. SCRAM); client-certificate or ACME provisioning for syslog TLS.

## 6. Credentials

Read from env only. Never written to `audit_events`, logs, or error objects (same rule as PLAN.md §軟體安全 and `safeErr`: no secrets, no SMTP passwords, no webhook userinfo). Recommend a webhook HMAC: header `X-SD-Alert-Signature: t=<unix_ms>,v1=<hex>`, HMAC-SHA256 of `t + "." + raw_body` with `SD_ALERT_WEBHOOK_HMAC_SECRET`, 5-minute replay window. Whether the secret is required when the URL is set is an open question.

## 7. SSRF

Webhook and syslog hosts are resolved, then checked with the existing B5 `isGlobalUnicast` ranges (private, loopback, link-local, reserved, documentation, multicast). The connect pins that resolved address (TLS SNI stays the original hostname). Default: refuse. Explicit override: `SD_ALERT_WEBHOOK_ALLOW_PRIVATE` / `SD_ALERT_SYSLOG_ALLOW_PRIVATE` (for an on-prem collector). Re-check after every resolution; do not cache a pinned IP past a short TTL.

## 8. Payload minimisation

Proposed alert body: `kind`, `entry_id`, `case_id`, `confidence`, `hit_count` (from the case at enqueue; the auto_list audit does not store it), `expires_at`, `at`. Logs and delivery-failed audits never include an IP or CIDR (existing logging rule). Whether the admin-facing alert itself includes the host CIDR (`detail.ip`, already on `blacklist.auto_list` and on `GET /api/audit`) is an open question for 軟體大總召: an admin channel is not an application log, but it is still a copy of a source address leaving the control plane.

## 9. Commit breakdown

Each commit ≤ 400 lines, red then green, no package.json / lockfile changes. Roughly: (1) `alert_outbox` migration, enqueue from `blacklist.auto_list`, delivery loop + `SKIP LOCKED`, no send; (2) webhook; (3) SMTP; (4) syslog; (5) volume alert + health counts; (6) docs (`deploy-checklist` and this record as implemented).

## 10. Open questions for 軟體大總召 and A 組領航員

1. May the alert payload include the host CIDR, given that logs must not contain an IP?
2. Is webhook HMAC required whenever `SD_ALERT_WEBHOOK_URL` is set, or optional?
3. Is `ceil(0.8 * N)` the right volume threshold, or a fixed `N - 5`, or an env?
4. Should a volume alert also be enqueued when the breaker actually opens (`blacklist.auto_breaker_open` already exists)?
5. Is plaintext SMTP opt-in (`SD_ALERT_EMAIL_ALLOW_PLAINTEXT`) allowed at all, or always refuse?
6. Are the private-host override envs acceptable for on-prem syslog/webhook collectors?
7. Confirm retry: 8 attempts, 1s × 2, cap 15 minutes.
8. Confirm failed deliveries are visible both as `alert.delivery_failed` on `GET /api/audit` and as counts on `GET /api/health`.
9. Confirm delivery stays in the control-api process (second timer), not a new worker program (PLAN.md keeps settings and audit in Postgres; a new process would be a tech-selection change).
10. Should DKIM, extra SASL, or syslog client certificates be deferred forever, or asked of the mail/syslog relay only?
