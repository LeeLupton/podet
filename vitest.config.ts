import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

// Run tests inside the real Workers runtime (workerd) so D1, Web Crypto, etc.
// behave exactly as in production. A local D1 binding "DB" is provided; the
// schema is applied per-test in test/api.test.ts.
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        miniflare: {
          compatibilityDate: '2024-09-23',
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: { DB: 'podnet-test' },
          bindings: { SESSION_SECRET: 'test-secret-not-for-production' },
        },
      },
    },
  },
})
