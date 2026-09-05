// Runs with no dependencies:
//   node --experimental-strip-types plugins/secret-redactor/test/detect.test.mts
//
// The two lists below are the whole contract. A change to a threshold or a
// pattern is only finished when both still pass.
import { makeConfig, scrubSecrets, scrubPii, restore } from '../hooks/redact.ts'

const cfg = makeConfig({})
const scrub = (text: string): string => scrubPii(scrubSecrets(text, cfg), cfg)

const HIDE: readonly string[] = [
  'ANTHROPIC_API_KEY=sk-ant-api03-Zx8Q2mLpR7vT4nK9wYbF1cJhE6sAdG0uH3iO5rP',
  'export GITHUB_TOKEN=ghp_1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ',
  'aws_access_key_id = AKIAIOSFODNN7EXAMPLE',
  'STRIPE_SECRET=sk_live_51H8xQ2LpR7vT4nK9wYbF1cJhE6s',
  'db: postgres://acs:S3cur3-p4ss-w0rd-here@db.example.com:5432/main',
  'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  'R2_SECRET_ACCESS_KEY="C3J27XDCG2LmlZGEONYlgCtjfIZ4SOcM"',
  'a bare high-entropy token z9CPVNPkNa1Hedcm4pMbXDuCL1mHoOsF here',
  'AIzaSyCjoSAqe6M7N3dSdh-uygUgSuBjkYnYhiw',
  'contact me at dana.whitfield@northwind-labs.io',
  'origin 91.198.174.192 hit the worker',
  'v6 2001:0db8:85a3:0000:0000:8a2e:0370:7334 seen',
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1a2b3c\n-----END RSA PRIVATE KEY-----',
]

const KEEP: readonly string[] = [
  'commit 79a1e9dd8f3b2c1a4e5d6f7089abcdef01234567 landed on main',
  'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'apps/nextjs/src/components/agentengineer/school/school-styles.ts',
  'http://localhost:3000/api/auth and 127.0.0.1:5432',
  'private net 192.168.1.14 and 10.0.0.7 and 172.16.4.2 and 203.0.113.9',
  'Co-Authored-By: Claude <noreply@anthropic.com>',
  'ray-amjad@users.noreply.github.com',
  'Claude Code 2.1.260 released 2026-09-04',
  'const IN_FLIGHT = new Set([QUEUED, BUILDING, INITIALIZING])',
  'npm install @anthropic-ai/claude-code --save-dev',
  'PLANETSCALE_DATABASE_URL is set in Infisical prod',
  // Stripe hands these out in public. Hiding them protects nothing.
  'monthly: "price_1Q4RmZKtVnpLXbYc82F0dTgW", productId: "prod_Rbk7HDpQ2mXvLe"',
  'only promo_1M3KpsDvNrqYTcbG7h2xWzQe is active',
  'pk_live_51H8xQ2LpR7vT4nK9wYbF1cJhE6sAdG0u',
  // Names, not keys.
  'key="archived-modules-marker"',
  'const OUTLINE_OPEN_KEY = "lesson_article_outline_open_v1";',
  'import { playerEventBatchV1Schema } from "./player-event-ingest";',
  'export function randomTimestampWithinLast14Days(): string {',
  'META_Conv_Lookalike-Customers_FreeTrial_2024Q1',
  'const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";',
  'utm_source=youtube&utm_medium=video_description&utm_campaign=dQw4w9WgXcQ',
  'The channel ID is UCq7NmTfKbrWzXd4LpHveAJs (a channel)',
  'placeholder="you@example.com" and name@company.com',
]

let bad = 0
for (const text of HIDE) {
  if (scrub(text) === text) {
    bad++
    console.log(`MISS  ${text.split('\n')[0].slice(0, 100)}`)
  }
}
for (const text of KEEP) {
  const out = scrub(text)
  if (out !== text) {
    bad++
    console.log(`FALSE POSITIVE  ${out.slice(0, 120)}`)
  }
}

// A value always mints the same placeholder, and the placeholder always
// buys the value back.
const line = 'KEY=sk-ant-api03-Zx8Q2mLpR7vT4nK9wYbF1cJhE6sAdG0uH3iO5rP'
if (scrub(line) !== scrub(line)) {
  bad++
  console.log('DRIFT  the same value minted two placeholders')
}
if (restore(scrub(line)) !== line) {
  bad++
  console.log('LOSS  a placeholder did not buy its value back')
}

console.log(bad === 0 ? `ok  ${HIDE.length} hidden, ${KEEP.length} kept, round trip clean` : `${bad} failure(s)`)
if (bad > 0) process.exitCode = 1
