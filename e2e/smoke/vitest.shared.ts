export const smokeVitestTestConfig = {
  env: { NODE_ENV: "production" },
  globalSetup: ["smoke/global-setup.ts"] as string[],
  hookTimeout: 180_000,
  // Cap parallel workers — Stripe test mode rate-limits at 25 ops/sec; too many
  // workers starting syncProducts simultaneously trips it. Pair with Stripe
  // SDK maxNetworkRetries for headroom.
  maxWorkers: 6,
  testTimeout: 600_000,
} as const;
