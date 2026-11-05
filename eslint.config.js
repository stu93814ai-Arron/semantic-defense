import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";
import reactHooks from "eslint-plugin-react-hooks";
export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "reports/**", "tools/**", "**/playwright-report/**", "**/test-results/**", "**/coverage/**"] },
  ...tseslint.configs.recommended,
  security.configs.recommended,
  { rules: { complexity: ["error", 10], "max-depth": ["error", 4], "max-lines-per-function": ["error", 80], "no-eval": "error", "no-implied-eval": "error" } },
  { files: ["**/*.tsx", "**/*.jsx"], languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { "react-hooks": reactHooks }, rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "error" } }
);
