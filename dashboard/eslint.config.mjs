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
    // eslint-config-next 16.x added very strict React Hooks rules. Rather than
    // disabling them outright, they are downgraded to `warn` for the existing
    // app/component/lib source — much of which legitimately fetches-on-mount
    // via `setState` inside an effect, exposes context-bound helper components,
    // or reads refs during render. These are surfaced (so they're visible in
    // lint output and can be paid down) but don't hard-fail CI on patterns the
    // codebase already relied on. Test files and tooling outside `src/` keep
    // the default (error) severity.
    //
    // NOTE: keep this glob broad enough to cover every `src/` file using the
    // fetch-on-mount pattern — narrowing it (e.g. app+lib only) silently
    // promotes the same pattern in `src/components/**` to a build-breaking
    // error.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/refs": "warn",
    },
  },
]);

export default eslintConfig;
