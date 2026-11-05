import { describe, expect, it } from "vitest";
import { CONTRACTS_PACKAGE } from "../src/index.js";
describe("contracts 骨架", () => {
  it("套件可載入", () => { expect(CONTRACTS_PACKAGE).toBe("@semantic-defense/contracts"); });
});
