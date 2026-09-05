import type { Register, PromptContextBlock } from 'claude-code'

// Keeps three classes of value out of the transcript: secrets, email
// addresses and IP addresses.
//
// The value is not deleted. It is put in a vault that lives in this module,
// in memory, for the session, and the transcript gets a placeholder in its
// place: `[REDACTED-SECRET-1a2b3c4d]`. The same value always mints the same
// placeholder, so the model can still tell one customer from another, and
// the placeholder is swapped back for the real value on the way into a tool
// call, so a `Bash` command or a `Write` still carries the real key.
//
// Nothing is written to disk. The vault dies with the session.

type Kind = 'SECRET' | 'EMAIL' | 'IP'

export type Config = {
  secrets: boolean
  pii: boolean
  restore: boolean
  notify: boolean
  minEntropy: number
  minLength: number
  contextMinEntropy: number
  privateIps: boolean
  allow: ReadonlySet<string>
  allowEmails: readonly string[]
  allowPrefix: readonly string[]
  denyPrefix: readonly string[]
}

// ---------------------------------------------------------------- the vault

const byValue = new Map<string, string>()
const byTag = new Map<string, string>()
let hidden = 0

const TAG = /\[REDACTED-(?:SECRET|EMAIL|IP)-[0-9a-f]{8}\]/g

function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

function mint(kind: Kind, value: string): string {
  hidden++
  const seen = byValue.get(value)
  if (seen) return seen
  const tag = `[REDACTED-${kind}-${fnv1a(value)}]`
  byValue.set(value, tag)
  byTag.set(tag, value)
  return tag
}

export function restore(text: string): string {
  if (byTag.size === 0) return text
  return text.replace(TAG, (tag) => byTag.get(tag) ?? tag)
}

// ------------------------------------------------------------ secret tests

// Shapes that belong to one vendor and mean one thing. These are hidden on
// sight, whatever their entropy.
const VENDOR = new RegExp(
  [
    'sk-ant-[A-Za-z0-9_-]{16,}',
    'sk-[A-Za-z0-9_-]{20,}',
    'gh[pousr]_[A-Za-z0-9]{20,}',
    'github_pat_[A-Za-z0-9_]{20,}',
    'xox[baprse]-[A-Za-z0-9-]{10,}',
    'xapp-[0-9]-[A-Za-z0-9-]{10,}',
    'A(?:KIA|SIA)[0-9A-Z]{16}',
    '[sr]k_(?:live|test)_[A-Za-z0-9]{16,}',
    'whsec_[A-Za-z0-9]{16,}',
    'AIza[0-9A-Za-z_-]{30,}',
    'ya29\\.[A-Za-z0-9_-]{20,}',
    'npm_[A-Za-z0-9]{30,}',
    'dop_v1_[a-f0-9]{40,}',
    'glpat-[A-Za-z0-9_-]{16,}',
    'shpat_[a-f0-9]{32,}',
    'SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}',
    'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}',
    'https://hooks\\.slack\\.com/services/[A-Za-z0-9/+_-]{16,}',
    'https://discord(?:app)?\\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]{16,}',
  ].join('|'),
  'g',
)

const PRIVATE_KEY = /-----BEGIN[^\n-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^\n-]{0,40}PRIVATE KEY-----/g

// Base64 padding rides along with the token; `=` is kept out of the run so a
// `name=value` pair does not read as one token.
// The password inside a connection string: postgres://user:PASSWORD@host.
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s/@:]{1,80}):([^\s/@]{3,200})@/gi

// A run of the characters a key is made of. `/` and `.` are left out on
// purpose: with them in, every long file path becomes a candidate.
const CANDIDATE = /[A-Za-z0-9+_-]{12,200}={0,2}/g

// A name to the left of the candidate that says the candidate is a key.
const NAMED =
  /(?:key|token|secret|password|passwd|pwd|credential|auth|bearer|private|signature|session|cookie|dsn|salt|nonce|otp)["'\]\s]{0,4}[:=]{1,2}\s*["'`]?\s*$/i

const HEX_ONLY = /^[0-9a-f]+$/i
const DIGITS_ONLY = /^[0-9]+$/

// Prefixes that name a PUBLIC object id, not a key. Stripe hands these out in
// dashboards, invoices and source code; hiding them makes a session useless
// and protects nothing. `pk_live_` is Stripe's publishable key, also public.
// Public ids with a shape rather than a prefix: a YouTube channel id.
const PUBLIC_SHAPE = /^(?:UC[A-Za-z0-9_-]{22}|PL[A-Za-z0-9_-]{16,32})$/

const PUBLIC_PREFIX =
  /^(?:price|prod|cus|sub|sched|in|ch|pi|cs|py|re|txn|il|si|seti|evt|acct|promo|coupon|plan|card|ba|src|dp|du|iv|ii|rcpt|file|link|pm|tok|pk|test|toolu|msg|req|run|wf)_/i

// A name written in code (`archived-modules-marker`, `handleCheckoutSession`,
// `lesson_article_outline_open_v1`) reads as high entropy but is a word list.
// A key is not built out of words.
const WORD_PART = /^(?:[a-z]+[0-9]{0,3}|[A-Z][a-z]+[0-9]{0,3}|[A-Z]{2,})$/
const ALNUM_ONLY = /^[A-Za-z0-9]+$/
const SEGMENTS = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g
const WORDY = /^[A-Za-z]?[a-z]{2,}$/

// `playerEventBatchV1Schema` splits into six segments of which four are
// words; a random key splits into many segments of which almost none are.
function isCamelName(token: string): boolean {
  if (!ALNUM_ONLY.test(token)) return false
  const segs = token.match(SEGMENTS)
  if (!segs || segs.join('') !== token) return false
  const words = segs.filter((seg) => WORDY.test(seg)).length
  return words >= 2 && words >= segs.length - 2
}

function looksLikeName(token: string, named: boolean): boolean {
  if (isCamelName(token)) return true
  // Every character used once: an alphabet constant, not a key. A random key
  // of this length repeats a character with near certainty. A name beside the
  // token outweighs this, so the rule only runs when there is none.
  if (!named && token.length >= 20 && new Set(token).size === token.length) return true
  const parts = token.split(/[_-]/)
  if (parts.length >= 2 && parts.every((p) => WORD_PART.test(p))) return true
  // Three or more separated parts, two of them plain words: a naming
  // convention (`META_Conv_Lookalike-Customers_FreeTrial_2024Q1`), not a key.
  return parts.length >= 3 && parts.filter((p) => /^[A-Za-z]{4,}$/.test(p)).length >= 2
}

function entropy(text: string): number {
  const counts = new Map<string, number>()
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) {
    const p = n / text.length
    h -= p * Math.log2(p)
  }
  return h
}

function looksSecret(token: string, before: string, cfg: Config): boolean {
  if (token.startsWith('REDACTED-')) return false
  if (cfg.allow.has(token)) return false
  if (DIGITS_ONLY.test(token)) return false
  if (PUBLIC_SHAPE.test(token)) return false
  if (PUBLIC_PREFIX.test(token) && !cfg.denyPrefix.some((p) => token.startsWith(p))) return false
  if (cfg.allowPrefix.some((p) => token.startsWith(p))) return false

  const named = NAMED.test(before)
  if (looksLikeName(token, named)) return false

  const h = entropy(token)

  // A bare hex run is a git SHA or a checksum far more often than it is a
  // key, so hex needs a name beside it before it is hidden.
  if (HEX_ONLY.test(token)) return named && token.length >= 24 && h >= cfg.contextMinEntropy

  const mixed = /[a-z]/.test(token) && /[A-Z]/.test(token) && /[0-9]/.test(token)
  if (mixed && token.length >= cfg.minLength && h >= cfg.minEntropy) return true
  // Next to a key's name the bar is lower, but the token still has to look
  // like a key: letters and digits together, not a word.
  const alnum = /[0-9]/.test(token) && /[A-Za-z]/.test(token)
  return named && alnum && token.length >= 16 && h >= cfg.contextMinEntropy
}

export function scrubSecrets(text: string, cfg: Config): string {
  let out = text
  out = out.replace(PRIVATE_KEY, (m) => mint('SECRET', m))
  out = out.replace(VENDOR, (m) => (cfg.allow.has(m) ? m : mint('SECRET', m)))
  out = out.replace(URL_PASSWORD, (m, head: string, password: string) =>
    cfg.allow.has(password) ? m : `${head}:${mint('SECRET', password)}@`,
  )
  out = out.replace(CANDIDATE, (token: string, offset: number, whole: string) => {
    const before = whole.slice(Math.max(0, offset - 64), offset)
    return looksSecret(token, before, cfg) ? mint('SECRET', token) : token
  })
  return out
}

// --------------------------------------------------------------- PII tests

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g

const OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])'
const IPV4 = new RegExp(`(?<![0-9.])(?:${OCTET}\\.){3}${OCTET}(?![0-9.])`, 'g')
const IPV6 = /(?<![0-9A-Za-z:])(?:[0-9A-Fa-f]{1,4}:){4,7}[0-9A-Fa-f]{1,4}(?![0-9A-Za-z:])/g

function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
  if (p[0] === 192 && p[1] === 168) return true
  if (p[0] === 169 && p[1] === 254) return true
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true
  if (p[0] >= 224) return true // multicast, reserved, broadcast
  if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true // benchmarking
  // RFC 5737: ranges reserved for documentation. A fixture, never a person.
  if (p[0] === 192 && p[1] === 0 && p[2] === 2) return true
  if (p[0] === 198 && p[1] === 51 && p[2] === 100) return true
  if (p[0] === 203 && p[1] === 0 && p[2] === 113) return true
  return false
}

// Addresses that only ever stand in for a real one: form placeholders, docs
// and test fixtures. Hiding them is noise.
const EXAMPLE_DOMAIN =
  /@(?:example\.(?:com|org|net)|examples?\.[a-z]+|test|invalid|localhost|acme\.com|(?:your)?domain\.com|company\.com|email\.com|mail\.com|foo\.com|bar\.com|sample\.com|placeholder\.[a-z]+)$/i
const EXAMPLE_LOCAL = /^(?:you|your|user|username|name|email|someone|test|example|placeholder|first\.last|jane|john|alice|bob|teammate|colleague|member|admin)(?:[.+_-]?[a-z0-9]{0,12})?@/i

function allowedEmail(address: string, cfg: Config): boolean {
  const low = address.toLowerCase()
  if (low.endsWith('@users.noreply.github.com')) return true
  if (low.startsWith('noreply@') || low.startsWith('no-reply@')) return true
  if (EXAMPLE_DOMAIN.test(low) || EXAMPLE_LOCAL.test(low)) return true
  return cfg.allowEmails.some((a) => {
    const rule = a.toLowerCase().trim()
    return rule.startsWith('@') ? low.endsWith(rule) : low === rule
  })
}

export function scrubPii(text: string, cfg: Config): string {
  let out = text
  out = out.replace(EMAIL, (m) => (allowedEmail(m, cfg) || cfg.allow.has(m) ? m : mint('EMAIL', m)))
  out = out.replace(IPV4, (m) => {
    if (cfg.allow.has(m)) return m
    if (!cfg.privateIps && isPrivateV4(m)) return m
    return mint('IP', m)
  })
  out = out.replace(IPV6, (m) => {
    if (cfg.allow.has(m)) return m
    const low = m.toLowerCase()
    if (!cfg.privateIps && (low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd'))) return m
    return mint('IP', m)
  })
  return out
}

// ------------------------------------------------------------- the walkers

const SKIP_KEYS = new Set(['data', 'base64', 'b64_json', 'imageData', 'thumbnail'])
const MAX_STRING = 8_000_000
const MAX_DEPTH = 12

function walk(value: unknown, fn: (s: string) => string, depth = 0): unknown {
  if (typeof value === 'string') return value.length > MAX_STRING ? value : fn(value)
  if (depth >= MAX_DEPTH) return value
  if (Array.isArray(value)) return value.map((v) => walk(v, fn, depth + 1))
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SKIP_KEYS.has(k) ? v : walk(v, fn, depth + 1)
    }
    return out
  }
  return value
}

// ---------------------------------------------------------------- register

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function strings(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim()).filter(Boolean)
  return []
}

export function makeConfig(options: Record<string, unknown>): Config {
  return {
    secrets: bool(options.secrets, true),
    pii: bool(options.pii, true),
    restore: bool(options.restoreInToolInputs, true),
    notify: bool(options.notify, true),
    minEntropy: num(options.minEntropy, 3.6),
    minLength: Math.max(8, num(options.minLength, 24)),
    contextMinEntropy: num(options.contextMinEntropy, 3.0),
    privateIps: bool(options.redactPrivateIps, false),
    allow: new Set(strings(options.allow)),
    allowEmails: strings(options.allowEmails),
    allowPrefix: strings(options.allowPrefixes),
    denyPrefix: strings(options.denyPrefixes),
  }
}

export const register: Register = (on, options) => {
  const cfg = makeConfig(options as Record<string, unknown>)

  const scrub = (text: string): string => {
    let out = text
    if (cfg.secrets) out = scrubSecrets(out, cfg)
    if (cfg.pii) out = scrubPii(out, cfg)
    return out
  }

  const secretsOnly = (text: string): string => (cfg.secrets ? scrubSecrets(text, cfg) : text)

  // 1. What the user types. A pasted key never reaches the model as itself.
  on('prompt.submit', async ($, e, next) => {
    const before = hidden
    const text = scrub(e.text)
    if (hidden > before && cfg.notify) {
      $.ui.toast(`secret-redactor: hid ${hidden - before} value(s) from the prompt`)
    }
    return next({ ...e, text })
  })

  // 2. What a tool reads back. This is where a secret usually arrives: a
  //    `cat .env`, a `Read` of a config, an API answer.
  on('tool.call', async ($, e, next) => {
    const input = cfg.restore ? (walk({ ...e }, restore) as typeof e) : e
    const r = await next(input)
    if (r.deny !== undefined) return r

    const before = hidden
    const result = walk(r.result, scrub)
    const text = r.text === undefined ? undefined : scrub(r.text)
    if (hidden === before) return r

    if (cfg.notify) $.ui.notice(e.tool_use_id, `secret-redactor: hid ${hidden - before} value(s)`)
    if (r.isError) return { isError: true as const, result, text, context: r.context }
    return { result, context: r.context }
  })

  // 3. The blocks attached to the first message (CLAUDE.md and friends).
  //    Secrets only: the email in there is the user's own, and the engine
  //    puts it there so the model knows who it is talking to.
  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    if (!cfg.secrets) return r
    const blocks: PromptContextBlock[] = r.blocks.map((b) => ({ ...b, text: secretsOnly(b.text) }))
    return { blocks }
  })
}
