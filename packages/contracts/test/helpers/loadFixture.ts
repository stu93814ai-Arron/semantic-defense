import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixturesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures",
);

/** 同步讀取假資料；可重複呼叫，應回傳相同內容。 */
export function loadFixture<T = unknown>(relativePath: string): T {
  const full = join(fixturesRoot, relativePath);
  return JSON.parse(readFileSync(full, "utf8")) as T;
}

export function fixtureJsonText(relativePath: string): string {
  return readFileSync(join(fixturesRoot, relativePath), "utf8");
}

export { fixturesRoot };
