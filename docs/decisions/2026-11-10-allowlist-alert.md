# 2026-11-10 Allowlist and auto_list alert decision record (Asia/Taipei)

## 2026-11-10 20:21 User decision (relayed by 軟體大總召)
- auto_list alerts must be pushed out proactively, supporting all three of email, webhook and syslog, chosen at install time.

## 2026-11-10 Ruling by 軟體大總召 (PM, adopting security's advice)
This is the PM's ruling and was not confirmed by the user.
- Only being able to look up the audit doesn't meet (c). (c) counts as done only once there's proactive push and it has passed security review.
- Push gets its own slice. It must include retry and logging for failed deliveries, and a volume alert when the breaker is near its limit. Prefer no external packages, and keep credentials out of the audit.
- This allowlist slice merges once it fixes the points security sent back. The blacklist.auto_list audit row is the data foundation for alerts.
- autoListEnabled stays default false. Default-on still requires (a)–(e) to be met, with (c) interpreted as above; there's no new precondition.
