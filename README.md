# awesome-claude-code-hooks

Claude Code **function hooks** that are worth installing.

A function hook is a TypeScript module that Claude Code loads and runs inside
the session. It sees each event as it happens, and it can change the event.
That is different from a shell hook: there is no subprocess, no JSON on stdin,
and it can draw in the terminal. The API is early access, so it moves.

This repo is a plugin marketplace. Add it once, then install what you want.

```
/plugin marketplace add ray-amjad/awesome-claude-code-hooks
/plugin install secret-redactor@awesome-claude-code-hooks
```

## The hooks

| Plugin | What it does |
| --- | --- |
| [secret-redactor](plugins/secret-redactor) | Swaps every secret, email address and IP address for a stable placeholder before the model reads it, then puts the real value back on the way into a tool call. Nothing goes to disk. |

## Work on this repo

The type declarations are **not in git**. Claude Code writes them, and every
release rewrites them, so a checked-in copy goes stale and lies to you.

Make them yourself. In Claude Code, from the root of this repo, run:

```
/plugin-types
```

That writes `types/claude-code.d.ts`. Every plugin's `tsconfig.json` points at
it with `"include": ["../../types", "hooks"]`. Do this first, or `tsc`
reports that `h`, `Box`, `Text` and the `claude-code` module do not exist.

Never hand-edit `types/claude-code.d.ts`. Run `/plugin-types` again instead.

Then check a plugin:

```bash
node --experimental-strip-types plugins/secret-redactor/test/detect.test.mts
claude plugin validate plugins/secret-redactor
npx tsc -p plugins/secret-redactor/tsconfig.json
```

Run a plugin without installing it:

```bash
claude --plugin-dir plugins/secret-redactor
```

## Add a hook

1. Make `plugins/<name>/` with `.claude-plugin/plugin.json` and
   `hooks/hooks.json`.
2. Point `hooks.json` at your module: `{ "modules": ["./your-hook.ts"] }`.
3. Copy `plugins/secret-redactor/tsconfig.json`. It already points at
   `../../types`.
4. Add a `test/` that runs on plain `node --experimental-strip-types`, with no
   dependencies.
5. Add the plugin to `.claude-plugin/marketplace.json` and to the table above.

## License

MIT. See [LICENSE](LICENSE).
