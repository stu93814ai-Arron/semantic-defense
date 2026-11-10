# 2026-11-09 Case flow decision record (Asia/Taipei)

## 21:09 Ruling by 軟體大總召 (PM)
This is the PM's ruling and was not confirmed by the user.
- R12 ts_ms: before stage 3 closes, right after batch 3 and before batch 4 (later moved ahead of batch 3 by the R18 ruling). ingest writes ts_ms, add an index on (sensor_id, app_id, src_ip, ts_ms), the judge reads ts_ms, and the migration backfills rows that can be converted. Rows that can't be converted fall under R15.
- R10 reserved addresses: ingest rejects loopback, link-local, multicast, broadcast, unspecified, 240/4, 2001:db8::/32 and other documentation ranges with 400, and the count must be visible in health or audit. RFC1918 and ULA are still accepted. hostCidr also excludes Class E and documentation ranges. The judge-side skip stays as a second line of defense. This is done as its own slice.
- ts lower bound: ingest rejects any ts earlier than now - 7 days (the retention period) with 400.

## 21:58 Ruling by 軟體大總召 (PM, batch 3 returned by security)
This is the PM's ruling and was not confirmed by the user.
- R18 takes option (a): ts_ms is its own small slice, goes to security first and merges first (merged as 17f6726, PR #20). Batch 3 then rebases onto it and removes or relaxes R14b. No quarantine table (b).
- B5, R19, R17 and the coverage scope go ahead as the 領航員 specified. If control-api isn't in coverage, add it.
- autoListEnabled is added in this batch. The development default is off, and the default is a single constant.
- Product items: (1) corroboration keeps the current E3.A rule of at least 2 distinct app_id or sensor_id values, because the first live test has only one sensor. (2) Spoofed sources: an alert when auto_list fires, and adding critical infrastructure to the allowlist at install time, go in the next slice. Counting only TCP connections that complete the three-way handshake is decided together with O5. (4) N = 50 per hour stays, and admins can change it. (5) Adding an IP to the allowlist automatically revokes any active block on it and writes an audit entry, in the next slice.

## 22:31 User decision (relayed by the PM)
- autoListEnabled defaults to on in production. The user was told about the risk that spoofed sources could cause wrong blocks and still chose on.
- Prerequisite: all of security's (a) B5, (b) install-time critical-infrastructure allowlist, (c) auto_list alerting, (d) three-way-handshake corroboration (O5), and (e) R15/R16 must be merged first. Then a small slice changes the default constant to on and adds a test. Until then, the development default is off.
- R-B (the startup migration holds ACCESS EXCLUSIVE until the backfill finishes) must also be fixed before the default-on slice.

## 23:21 User decision (relayed by the PM)
- R-D is accepted: when legacy rows are backfilled, a ts with 7 or more fractional digits may round to a value 1ms off from JS. This affects only legacy data, never new writes.

## 2026-11-11 A 組領航員裁示（未經使用者確認）
The eight implementation rulings for R10 (fields, exact prefixes, 400 body, `flow_rejections.reason`, check order, `hostCidr` only, remaining B5, `isReservedForIngest`) are recorded in `2026-11-11-r10-reserved.md`. They fall within the §21:09 R10 ruling above.
