import { describe, expect, it } from "vitest";
import { parseFlowMetadataEvent } from "../src/index.js";

type Obj = Record<string, unknown>;
type Case = [string, Obj, boolean];

const base = (): Obj => ({
  flow_id: "550e8400-e29b-41d4-a716-446655440000",
  app_id: "orders-app",
  ts: "2026-11-05T12:00:00.000Z",
  src_ip: "192.0.2.10",
  dst_ip: "198.51.100.20",
  src_port: 51234,
  dst_port: 443,
  protocol: "tcp",
  bytes_in: 0,
  bytes_out: 0,
  packets: 0,
  duration_ms: 0,
});

const omit = (...keys: string[]): Obj =>
  Object.fromEntries(Object.entries(base()).filter(([key]) => !keys.includes(key)));
const patch = (p: Obj): Obj => ({ ...base(), ...p });

describe("FlowMetadataEventSchema", () => {
  it.each<Case>([
    ["合法 IPv4/tcp", base(), true],
    ["合法 IPv6/udp", patch({
      src_ip: "2001:db8::1", dst_ip: "2001:db8::2", protocol: "udp",
    }), true],
    ["port 下界 1", patch({ src_port: 1 }), true],
    ["port 上界 65535", patch({ dst_port: 65535 }), true],
    ["缺 flow_id", omit("flow_id"), false],
    ["缺 app_id", omit("app_id"), false],
    ["缺 ts", omit("ts"), false],
    ["缺 src_ip", omit("src_ip"), false],
    ["缺 protocol", omit("protocol"), false],
    ["多欄 payload", patch({ payload: "x" }), false],
    ["多欄 url", patch({ url: "https://x" }), false],
    ["多欄 headers", patch({ headers: {} }), false],
    ["port 0", patch({ src_port: 0 }), false],
    ["port 65536", patch({ dst_port: 65536 }), false],
    ["port 非整", patch({ src_port: 1.5 }), false],
    ["protocol 非法", patch({ protocol: "icmp" }), false],
    ["protocol 大寫", patch({ protocol: "TCP" }), false],
    ["bytes_in 負", patch({ bytes_in: -1 }), false],
    ["packets 負", patch({ packets: -1 }), false],
    ["duration_ms 負", patch({ duration_ms: -1 }), false],
    ["CIDR src", patch({ src_ip: "192.0.2.0/24" }), false],
    ["IPv6 zone %", patch({ src_ip: "fe80::1%eth0" }), false],
    ["CIDR dst", patch({ dst_ip: "2001:db8::/64" }), false],
    ["非 IP", patch({ src_ip: "not-an-ip" }), false],
    ["空 IP", patch({ dst_ip: "" }), false],
    ["壞 uuid", patch({ flow_id: "not-uuid" }), false],
    ["壞 ts", patch({ ts: "2026-11-05" }), false],
    // 資安殘留 harden：與 ip-cidr 同規則（canonical、拒 mapped），但保留位址可過
    ["保留 v4 loopback", patch({ src_ip: "127.0.0.1" }), true],
    ["保留 v4 未指定", patch({ src_ip: "0.0.0.0" }), true],
    ["保留 v4 link-local", patch({ dst_ip: "169.254.1.1" }), true],
    ["保留 v4 multicast", patch({ dst_ip: "224.0.0.1" }), true],
    ["保留 v4 broadcast", patch({ dst_ip: "255.255.255.255" }), true],
    ["私有 v4", patch({ src_ip: "10.0.0.1" }), true],
    ["保留 v6 loopback", patch({ src_ip: "::1", dst_ip: "::1" }), true],
    ["保留 v6 未指定", patch({ src_ip: "::", dst_ip: "::1" }), true],
    ["保留 v6 link-local", patch({ src_ip: "fe80::1", dst_ip: "fe80::2" }), true],
    ["保留 v6 multicast", patch({ src_ip: "2001:db8::1", dst_ip: "ff02::1" }), true],
    ["v6 非 canonical 大寫", patch({ src_ip: "2001:0DB8::1" }), false],
    ["v6 非 canonical 大寫 hex", patch({ src_ip: "2001:DB8::1" }), false],
    ["v6 非 canonical 未壓縮", patch({ src_ip: "2001:db8:0:0:0:0:0:1" }), false],
    ["v6 非 canonical 前導零", patch({ dst_ip: "2001:db8::01" }), false],
    ["v6 IPv4-mapped 點分", patch({ src_ip: "::ffff:192.0.2.1" }), false],
    ["v6 IPv4-mapped hex", patch({ dst_ip: "::ffff:c000:201" }), false],
  ])("%s → ok=%s", (_n, input, ok) => {
    const r = parseFlowMetadataEvent(input);
    expect(r.ok).toBe(ok);
    if (!r.ok) {
      expect(r.errors.length).toBeGreaterThan(0);
      expect(JSON.stringify(r.errors)).not.toMatch(/192\.0\.2\.0\/24|payload|https:\/\//);
    }
  });
});
