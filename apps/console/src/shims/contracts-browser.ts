/**
 * 瀏覽器安全入口：contracts 根 index 會拉進 node:crypto（toCaseSummary），
 * Vite 瀏覽器建置不可用。console 只需要 ip-cidr 白名單驗證匯出。
 * 走套件子路徑（./ip-cidr 仍保留）；根入口由 vite 精確 alias 到本檔。
 */
export {
  assertAllowlistCidr,
  assertIpOrCidr,
  isHostPrefix,
  parseCidr,
} from "@semantic-defense/contracts/ip-cidr.js";
