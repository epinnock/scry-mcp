import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";

// F13 Sonar lint: PR #44 (capture-sources) fixed every sonarjs finding it
// introduced, but the repo carries 80 pre-existing findings this pass is not
// scoped to fix. Downgrade every sonarjs/* rule from the recommended config's
// "error" to "warn" so the lint script (below, --max-warnings 80) still
// blocks on any *new* finding without failing the build on the baseline.
const sonarjsWarnRules = Object.fromEntries(
  Object.entries(sonarjs.configs.recommended.rules).map(([rule, severity]) => [
    rule,
    severity === "error" ? "warn" : severity,
  ]),
);

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**"],
  },
  ...tseslint.configs.recommended,
  sonarjs.configs.recommended,
  {
    rules: sonarjsWarnRules,
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
