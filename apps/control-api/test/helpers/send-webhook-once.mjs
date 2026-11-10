import { readFileSync } from "node:fs";
import { parseWebhookConfig, sendWebhook } from "../../src/alert-webhook.js";

const pin = process.env.SD_TEST_PIN_ADDR ?? "";
const caFile = process.env.SD_TEST_CA_FILE ?? "";
/* eslint-disable security/detect-non-literal-fs-filename -- 測試行程讀取 mkdtemp CA */
const ca = caFile ? readFileSync(caFile, "utf8") : undefined;
/* eslint-enable security/detect-non-literal-fs-filename */
const cfg = parseWebhookConfig(process.env);
if (!cfg || !pin) process.exit(2);
const row = {
  id: "1", audit_id: null, channel: "webhook", kind: "auto_list",
  payload: { delivery_id: "1", kind: "auto_list", entry_id: "e", case_id: "c" },
  attempts: 0, next_attempt_at: "0", status: "pending", error_class: null, created_at: "0", delivered_at: null,
};
try {
  await sendWebhook(cfg, row, {
    ca,
    lookup: async () => [{ address: pin, family: 4 }],
    timeoutMs: Number(process.env.SD_TEST_TIMEOUT_MS ?? 5000),
  });
  process.exit(0);
} catch {
  process.exit(1);
}
