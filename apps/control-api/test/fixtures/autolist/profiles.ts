/**
 * 自動上榜驗收夾具（只寫資料，不打任何種子 API）。
 * 分數由 flow-verdict 的特徵算出：n 筆、uniquePorts 個目的埠、前 short 筆為短連線無回應、packets 為每筆封包數。
 * exact-090＝0.90、just-below-090＝略低於 0.90、exact-050＝0.50、below-050＝略低於 0.50、high＝1。
 * E3.A（§2b）：30 分鐘內三個 5 分鐘窗、至少兩個 app。
 */
export type ProfileName = "high" | "exact-090" | "just-below-090" | "exact-050" | "below-050";

export type FlowProfile = {
  readonly n: number;
  readonly uniquePorts: number;
  readonly short: number;
  readonly packets: number;
};

export const AUTOLIST_FIXTURE = {
  sensorId: "s-1",
  allowedAppIds: ["app-1", "app-2"],
  /** 三個窗都在 T0 前 30 分鐘內，且來自兩個 app。 */
  e3a: [
    { appId: "app-1", minutesBefore: 25 },
    { appId: "app-2", minutesBefore: 15 },
    { appId: "app-1", minutesBefore: 5 },
  ],
  publicIps: {
    off: "64.0.113.21",
    boundary: "64.0.113.22",
    single: "64.0.113.27",
    caseLine: "64.0.113.23",
    belowAuto: "64.0.113.24",
    belowCase: "64.0.113.25",
    allowlisted: "64.0.113.26",
  },
  /**
   * hostCidr 拒收（判定整組跳過）：loopback、未指定、link-local、多播、廣播、文件範圍、Class E。
   */
  skippedHosts: [
    "127.0.0.1", "::1", "0.0.0.0", "169.254.1.1", "fe80::1",
    "224.0.0.1", "255.255.255.255", "192.0.2.1", "240.0.0.1", "2001:db8::1",
  ],
  /** 可成案但非全域單播：私網、CGNAT、ULA。自動上榜必須拒絕。 */
  nonPublicHosts: ["10.1.2.3", "172.16.5.5", "192.168.9.9", "100.64.1.1", "fc00::1"],
  profiles: {
    high: { n: 30, uniquePorts: 30, short: 30, packets: 1 },
    "exact-090": { n: 30, uniquePorts: 30, short: 20, packets: 1 },
    "just-below-090": { n: 28, uniquePorts: 26, short: 23, packets: 1 },
    "exact-050": { n: 30, uniquePorts: 30, short: 0, packets: 4 },
    "below-050": { n: 37, uniquePorts: 14, short: 23, packets: 4 },
  },
} as const satisfies {
  sensorId: string;
  allowedAppIds: readonly string[];
  e3a: readonly { appId: string; minutesBefore: number }[];
  publicIps: Record<string, string>;
  skippedHosts: readonly string[];
  nonPublicHosts: readonly string[];
  profiles: Record<ProfileName, FlowProfile>;
};

export function profileOf(name: ProfileName): FlowProfile {
  const all = AUTOLIST_FIXTURE.profiles;
  if (name === "high") return all.high;
  if (name === "exact-090") return all["exact-090"];
  if (name === "just-below-090") return all["just-below-090"];
  if (name === "exact-050") return all["exact-050"];
  return all["below-050"];
}
