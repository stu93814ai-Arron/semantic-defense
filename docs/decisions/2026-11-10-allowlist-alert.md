# 2026-11-10 Allowlist and auto_list alert decision record (Asia/Taipei)

## 2026-11-10 20:21 User decision (relayed by 軟體大總召)
- Proactive alerts for (c) auto_list must support email, webhook and syslog, chosen at install time. They need retry and logging for failed deliveries, a volume alert when the breaker is close to its limit, a preference for no external packages, and credentials kept out of the audit.

## 2026-11-10 Ruling by 軟體大總召 (PM)
This is the PM's ruling and was not confirmed by the user.
- Only being able to look up the audit doesn't meet (c); we agree with security.
- This allowlist slice merges once it fixes the points security sent back. The blacklist.auto_list audit row is the data foundation for alerts. Proactive push is its own slice.
- autoListEnabled stays default false.
