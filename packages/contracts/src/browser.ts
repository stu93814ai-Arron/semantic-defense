/**
 * 瀏覽器安全入口（`@semantic-defense/contracts/browser`）。
 * 本檔與其所有傳遞依賴不得引用 `node:` 或其他 node 內建（crypto、net…）；見 test/browser-entry.test.ts。
 * 只轉出 console 實際用到的：ip-cidr 公開 API、管理面 HTTP 契約（路徑常數、門檻、黑白名單與待審候選 schema）；
 * 與主入口為同一實作。
 */
export { parseCidr, assertIpOrCidr, assertAllowlistCidr, isHostPrefix } from "./ip-cidr.js";
export type { ParsedCidr } from "./ip-cidr.js";
export {
  ADMIN_API_PATHS, THRESHOLD_BOUNDS, ThresholdsSchema, thresholdsViolation,
  PendingCandidateSchema, PendingCandidateListSchema, BlocklistListSchema,
  AllowlistCreateSchema, AllowlistUpdateSchema, AllowlistListSchema,
} from "./admin-api.js";
export type {
  Thresholds, ThresholdsViolation, PendingCandidate, AllowlistCreate, AllowlistUpdate,
} from "./admin-api.js";
export { BlocklistEntrySchema } from "./blocklist-entry.js";
export type { BlocklistEntry } from "./blocklist-entry.js";
export { AllowlistEntrySchema } from "./allowlist-entry.js";
export type { AllowlistEntry } from "./allowlist-entry.js";
