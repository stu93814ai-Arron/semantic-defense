/**
 * 瀏覽器安全入口（`@semantic-defense/contracts/browser`）。
 * 本檔與其所有傳遞依賴不得引用 `node:` 或其他 node 內建（crypto、net…）；見 test/browser-entry.test.ts。
 * 只轉出 console 實際用到的驗證（白名單 CIDR）與同檔的 ip-cidr 公開 API；與主入口為同一實作。
 */
export { parseCidr, assertIpOrCidr, assertAllowlistCidr, isHostPrefix } from "./ip-cidr.js";
export type { ParsedCidr } from "./ip-cidr.js";
