import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    // The MCP SDK loads AJV's JSON schemas through CommonJS require(). Bundle
    // them so the Workers pool does not try to execute JSON as JavaScript.
    deps: { optimizer: { ssr: { include: ["ajv", "ajv-formats"] } } },
    exclude: ["test/e2e.test.ts", "node_modules/**"],
    poolOptions: {
      workers: {
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
        miniflare: {
          compatibilityDate: "2025-03-10",
          compatibilityFlags: ["nodejs_compat"],
          kvNamespaces: ["OAUTH_KV"],
          // The top-level (production) vars turn the gateway and Langfuse on; tests start
          // from "off" and opt in per test, as they did before production enabled them.
          // Dynamic sampling is off by default too, so a test that turns Langfuse on never
          // fetches the diff-service sampling endpoint unless it opts in (with a stubbed fetch).
          // Credits likewise start "off" (production enforces, which fails closed without a ledger).
          bindings: { CREDITS_MODE: "off", LLM_GATEWAY_URL: "", LANGFUSE_ENABLED: "0", LANGFUSE_SAMPLE_RATE: "1", LANGFUSE_DYNAMIC_SAMPLING: "0" },
        },
      },
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"], // thin entrypoint, tested via integration/e2e
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});
