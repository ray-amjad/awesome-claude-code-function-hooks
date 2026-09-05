# secret-redactor

Keeps three classes of value out of the session transcript: secrets, email
addresses and IP addresses.

> **Turn function hooks on first.** This is a Claude Code **function hook**,
> the early-access feature proposed in
> [anthropics/claude-code#91870](https://github.com/anthropics/claude-code/issues/91870).
> It is off by default, and this plugin does nothing until you turn it on. Add
> `"env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" }` to
> `~/.claude/settings.json`, or start one session with
> `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude`.

The value is not destroyed. It goes into a vault that lives in the hooks
module, in memory, for the session, and the transcript gets a placeholder in
its place:

```
ANTHROPIC_API_KEY=[REDACTED-SECRET-164d0c98]
SUPPORT_EMAIL=[REDACTED-EMAIL-6f096ff7]
EDGE_ORIGIN=[REDACTED-IP-6fc52d2b]
```

The same value always mints the same placeholder, so the model can still tell
one customer from another. The placeholder is swapped back for the real value
on the way into a tool call, so a `Bash` command or a `Write` still carries the
real key. Nothing is written to disk. The vault dies with the session.

## The three hooks

| Event | What it does |
| --- | --- |
| `prompt.submit` | A key you paste never reaches the model as itself |
| `tool.call` | Puts real values back into the tool's input, then hides them again in the tool's result. This is where a secret usually arrives: a `cat .env`, a `Read` of a config, an API answer |
| `prompt.context` | Hides secrets in the blocks attached to the first message. Emails are left alone there: the engine puts your own address in that block so the model knows who it is talking to |

## What counts as a secret

Three tests, in order.

1. **A vendor shape.** `sk-ant-`, `ghp_`, `AKIA`, `sk_live_`, `whsec_`, `AIza`,
   `xoxb-`, a JWT, a Slack or Discord webhook, a `PRIVATE KEY` block, the
   password inside a `postgres://user:pass@host` string. Hidden on sight.
2. **Entropy plus mixed case.** A token of 24 characters or more that carries
   lower case, upper case and digits, above 3.6 bits per character.
3. **Entropy plus a name.** A shorter token, above 3.0 bits per character, that
   sits after `API_KEY=`, `"token":`, `Bearer`, `password:` and the like.

Four rules stop the noise. Together they take a large Next.js monorepo down to
two hits across its whole tracked source tree, and both are real secrets.

- **A public id is not a secret.** `price_`, `prod_`, `cus_`, `promo_`,
  `pk_live_` and the rest of Stripe's object ids, and a YouTube channel id, are
  printed in dashboards and in source. Hiding them protects nothing.
- **A name is not a key.** `archived-modules-marker`,
  `lesson_article_outline_open_v1`, `playerEventBatchV1Schema`,
  `randomTimestampWithinLast14Days` and
  `META_Conv_Lookalike-Customers_FreeTrial_2024Q1` all read as high entropy.
  They are word lists. A key is not built out of words.
- **An alphabet is not a key.** A token of 20 characters or more that uses
  every character once is a charset constant. A real key of that length
  repeats a character with near certainty.
- **Bare hex needs a name beside it.** A 40-character hex run is a git SHA or a
  checksum far more often than it is a key, so hex only counts as a secret when
  `API_KEY=` or `"token":` sits in front of it.

## What counts as PII

- **Email addresses.** Skipped: `noreply@`, `@users.noreply.github.com`,
  documentation domains (`@example.com`, `@company.com`, `@test`),
  placeholder local parts (`you@`, `name@`, `admin@`), and anything in
  `allowEmails`. Put your own published addresses in that option, as
  `@yourdomain.com`, so your own contact address stays readable.
- **IP addresses**, v4 and v6. Private and reserved ranges stay visible by
  default, because `127.0.0.1:3000` is everywhere in dev: loopback, `10.x`,
  `192.168.x`, `172.16-31.x`, link-local, carrier-grade NAT, multicast, the
  benchmarking range, and the RFC 5737 documentation ranges. Set
  `redactPrivateIps` to hide those too.

## Options

Set them per plugin under `pluginConfigs` in your **user** settings.

| Option | Default | What it does |
| --- | --- | --- |
| `secrets` | `true` | Hide secrets |
| `pii` | `true` | Hide emails and IP addresses |
| `restoreInToolInputs` | `true` | Put the real value back before a tool runs |
| `notify` | `true` | Count on the tool row, toast on a prompt |
| `minEntropy` | `3.6` | Bits per character for the mixed-case test |
| `minLength` | `24` | Shortest token the mixed-case test looks at |
| `contextMinEntropy` | `3.0` | Bits per character when a key name sits in front |
| `redactPrivateIps` | `false` | Hide reserved ranges too |
| `allow` | `""` | Exact strings to leave alone, separated by commas |
| `allowEmails` | `""` | Addresses, or `@domain.com`, separated by commas |
| `allowPrefixes` | `""` | Extra id prefixes to treat as public |
| `denyPrefixes` | `""` | Prefixes to put back under the entropy test |

## Two things it does not do

- **It does not hide a secret the model itself writes.** Only what the model
  reads is scanned. A key the model types into a command is a key it already
  had.
- **It does not survive a restart.** The vault is memory only. Placeholders
  from an earlier session are meaningless in a new one.

## Testing

Run every command from the root of this repo.

Step 1. Make the type declarations. They are not in git, because a new Claude
Code release rewrites them. This command writes `types/claude-code.d.ts`, which
`tsconfig.json` points at:

```
/plugin-types
```

Step 2. Run the detector test and the plugin validator:

```bash
node --experimental-strip-types plugins/secret-redactor/test/detect.test.mts
claude plugin validate plugins/secret-redactor
```

`test/detect.test.mts` holds two lists: values that must be hidden and values
that must be kept. A change to a threshold or a pattern is only finished when
both still pass.

Step 3. Try it end to end:

```bash
claude --plugin-dir plugins/secret-redactor \
  -p "cat plugins/secret-redactor/test/fixtures/sample.env, then repeat the values back"
```
