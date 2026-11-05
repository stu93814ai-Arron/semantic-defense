import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";
export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "reports/**", "tools/**"] },
  ...tseslint.configs.recommended,
  security.configs.recommended,
  { rules: { complexity: ["error", 10], "max-depth": ["error", 4], "max-lines-per-function": ["error", 80], "no-eval": "error", "no-implied-eval": "error" } }
);
