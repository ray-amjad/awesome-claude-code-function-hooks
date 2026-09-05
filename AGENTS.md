# AGENTS.md

Notes for an agent working in this repo. Read this before you write code.

## Turn the feature on first

Every plugin here is a **function hook**, the early-access feature from
[anthropics/claude-code#91870](https://github.com/anthropics/claude-code/issues/91870).
Function hooks are off by default. A plugin loads and then does nothing, with
no error, until the flag is on.

If you are debugging "the hook never fires", check this before anything else:

```bash
echo "$CLAUDE_CODE_ENABLE_FUNCTION_HOOKS"
```

Turn it on in `~/.claude/settings.json` under `env`, or per run with
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude`.

## Get the types first

`types/claude-code.d.ts` is **gitignored on purpose**. It is 200 KB of
generated output, and each Claude Code release rewrites it, so a committed
copy goes stale and describes an API that no longer exists.

Run this in Claude Code, from the root of this repo, before anything else:

```
/plugin-types
```

Do not write the file by hand. Do not fetch it from anywhere. Do not commit
it. If `tsc` says `h`, `Box`, `Text`, `Register` or the `claude-code` module
is missing, the answer is always `/plugin-types`, not a new declaration.

The command stamps the Claude Code version it ran under at the top of the
file. If that version is older than the CLI in use, run it again.

## Layout

- `.claude-plugin/marketplace.json` lists every plugin. A new plugin is not
  installable until it has an entry here.
- `plugins/<name>/` is one plugin. Each one carries its own `plugin.json`,
  `hooks/hooks.json`, `tsconfig.json`, `README.md` and `test/`.
- Each `tsconfig.json` reaches the shared types with
  `"include": ["../../types", "hooks"]`.

## Rules

1. **A test runs on bare Node.** Use
   `node --experimental-strip-types <file>.mts`. This repo has no package.json,
   no dependencies and no test runner. Keep it that way.
2. **Keep defaults neutral.** This is a public repo. No personal domains, no
   personal email addresses, no repo-specific paths in a default value.
3. **Bump two versions together.** A plugin's `version` lives in both
   `plugins/<name>/.claude-plugin/plugin.json` and in that plugin's entry in
   `.claude-plugin/marketplace.json`. They must match.
4. **Check before you push.**

   ```bash
   node --experimental-strip-types plugins/secret-redactor/test/detect.test.mts
   claude plugin validate plugins/secret-redactor
   npx tsc -p plugins/secret-redactor/tsconfig.json
   ```

## secret-redactor

The detector's contract is the two lists in
`plugins/secret-redactor/test/detect.test.mts`: `HIDE` and `KEEP`. A change to
a threshold or a pattern is finished only when both lists still pass. Add a
case to the right list with every change.

`test/fixtures/sample.env` and the `HIDE` list hold fake keys on purpose. Do
not "fix" them and do not replace them with placeholders. Every one is
synthetic: each was hashed and compared against every credential file on the
author's machine, and none matched.

**Never put a real value in a fixture.** Invent it. `.gitleaks.toml` allowlists
`plugins/*/test/`, so a real key dropped there would pass the scanner in
silence. That allowlist is a promise, not a licence.

Careful: if you run a Claude Code session with this plugin active, the values
in the test file and the fixture read as redacted placeholders in your context.
Copy those files with `cp`, and edit them with targeted `sed` or a string
replace. Never rewrite one of them whole from what you see, or you write a
placeholder into git.
