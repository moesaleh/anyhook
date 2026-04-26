import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Playwright artifacts and config (vitest globs cover unit tests, not
    // these). The e2e tests use Playwright's globals via the @playwright/test
    // import, not jest globals — separate lint scope.
    "test-results/**",
    "playwright-report/**",
    "e2e/**",
    "playwright.config.ts",
  ]),
  {
    rules: {
      // eslint-config-next 16.x added very strict React Hooks rules that flag
      // patterns the existing codebase uses heavily. Downgrade to warn so CI
      // doesn't block; revisit if the patterns are actually causing bugs.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/refs": "warn",
    },
  },
]);

export default eslintConfig;
