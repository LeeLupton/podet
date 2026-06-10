import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Run tests inside the real Workers runtime (workerd) so D1, R2, Web Crypto, etc.
// behave exactly as in production. Local D1/R2 bindings are provided below; the
// schema is applied per-suite in test/helpers.ts.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2024-09-23',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: 'podnet-test' },
        r2Buckets: { PHOTOS: 'podnet-photos-test' },
        bindings: { SESSION_SECRET: 'test-secret-not-for-production' },
      },
    }),
  ],
})
