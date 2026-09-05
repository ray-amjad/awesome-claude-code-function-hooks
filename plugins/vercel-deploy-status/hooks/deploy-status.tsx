/** @jsx h */
import type { Register, EngineInterface, Timer } from 'claude-code'
import {
  type Deployment,
  type Row,
  IN_FLIGHT,
  LABEL,
  DOT,
  COLOR,
  LABEL_WIDTH,
  num,
  elapsed,
  cut,
  plural,
  targetOf,
  parseList,
  header,
  clock,
  merge,
  isDeployCommand,
} from './queue.ts'

// The Vercel deploy queue of the linked project, drawn as a block in the band
// above the prompt: a header with the counts, then one line per deploy that is
// queued, building, or just finished. It polls `vercel ls` on the host and
// never starts a turn.
//
// A push or a PR merge wakes it: the Bash call that ran `git push`,
// `gh pr merge` or `vercel deploy` puts the block into "waiting" and polls at
// the active rate until a deploy shows up.
//
// Everything with no UI in it lives in ./queue.ts, where a bare Node test
// can reach it.

// The directory `vercel` must run from: the nearest one holding a link file.
// The session's directory first, then the repo root, then a short search for
// a linked package inside a monorepo.
async function findLinkedDir($: EngineInterface, cwd: string): Promise<string | null> {
  if (await $.fs.exists(`${cwd}/.vercel/project.json`)) return cwd

  const root = (await $.session.repo())?.root ?? cwd
  if (root !== cwd && (await $.fs.exists(`${root}/.vercel/project.json`))) return root

  try {
    const r = await $.process.run(
      ['find', root, '-maxdepth', '4', '-type', 'd', '-name', 'node_modules', '-prune', '-o',
       '-type', 'f', '-path', '*/.vercel/project.json', '-print'],
      { timeoutMs: 10_000 },
    )
    const hit = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)[0]
    if (hit) return hit.slice(0, -'/.vercel/project.json'.length)
  } catch {
    // No `find`, or it timed out. The plugin stays quiet, which is the point.
  }
  return null
}

export const register: Register = (on, options) => {
  const vercelBin = String(options.vercelBin || 'vercel')
  const activeMs = num(options.activePollSeconds, 15) * 1000
  const idleMs = num(options.idlePollSeconds, 60) * 1000
  const holdMs = num(options.holdFinishedMinutes, 5) * 60 * 1000
  const watchMs = num(options.watchAfterPushMinutes, 6) * 60 * 1000
  const maxRows = Math.floor(num(options.maxRows, 8))

  // The band reads these; session.start's poll loop writes them. They live
  // out here because the two hooks are separate closures.
  let project = 'vercel'
  let rows: Row[] = [] // the queue on the band, newest first
  let pushedAt: number | null = null // when a push last asked us to look

  // Set by session.start once the project is linked; until then a push has
  // nothing to wake.
  let wake: (() => void) | null = null

  const waiting = (now: number): boolean => pushedAt !== null && now - pushedAt < watchMs
  const inFlightRows = (): Row[] => rows.filter((r) => IN_FLIGHT.has(r.d.state))

  on('ui.render', { component: 'AbovePrompt', surface: 'terminal' }, async ($, e, next) => {
    // A survey owns the band while it is up, and there is nothing to draw
    // when the queue is empty and no push is waiting on a deploy.
    if (e.props.hasSurvey) return next(e)
    const now = $.clock.now()
    if (rows.length === 0 && !waiting(now)) return next(e)

    const { Box, Text } = await $.ui.resolve(e)

    const shown = rows.slice(0, maxRows)
    const hidden = rows.length - shown.length

    // Two JSX rules of this runtime, learned the hard way: a `.map()` array
    // is not a valid Box child, so it is wrapped in a Fragment; and `key` is
    // a Button prop only, so no row carries one.
    return (
      <Box flexDirection="column">
        <Text dimColor>{header(project, rows)}</Text>
        {waiting(now) && inFlightRows().length === 0 ? (
          <Text dimColor>{`◌ waiting for a deploy   ${elapsed(now - pushedAt!)}`}</Text>
        ) : (
          <Text>{''}</Text>
        )}
        <>
          {shown.map((r) => {
            const d = r.d
            const ref = d.meta?.githubCommitRef ?? ''
            const where = [targetOf(d), ref].filter(Boolean).join(' · ')
            const subject = d.meta?.githubCommitMessage ? cut(d.meta.githubCommitMessage, 72) : ''
            return (
              <Box gap={2}>
                <Text color={COLOR[d.state]}>{`${DOT[d.state]} ${LABEL[d.state].padEnd(LABEL_WIDTH)}`}</Text>
                <Text dimColor>{where}</Text>
                <Text>{clock(r, now)}</Text>
                {subject ? <Text dimColor wrap="truncate-end">{subject}</Text> : <Text>{''}</Text>}
              </Box>
            )
          })}
        </>
        {hidden > 0 ? <Text dimColor>{`  … and ${plural(hidden, 'more')}`}</Text> : <Text>{''}</Text>}
      </Box>
    )
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = typeof e.command === 'string' ? e.command : ''
    if (!isDeployCommand(command)) return next(e)

    // Let the push finish first: Vercel has nothing to report until it lands.
    const result = await next(e)
    wake?.()
    return result
  })

  on('session.start', async ($, e, next) => {
    if (!e.interactive || e.surface === null) return next(e)

    const dir = await findLinkedDir($, e.cwd)
    if (!dir) {
      $.ui.log('vercel-deploy-status: no .vercel/project.json in this repo, staying quiet')
      return next(e)
    }

    try {
      const link = JSON.parse(await $.fs.readFile(`${dir}/.vercel/project.json`)) as { projectName?: string }
      if (link.projectName) project = link.projectName
    } catch {
      // The label falls back to "vercel"; the CLI still resolves the link.
    }

    let errorShown = false

    // True while the loop should keep the active rate: a deploy is in flight,
    // or a push is still inside its watch window.
    const poll = async (): Promise<boolean> => {
      let list: Deployment[]
      try {
        const r = await $.process.run([vercelBin, 'ls', '--format', 'json', '--non-interactive'], {
          cwd: dir,
          timeoutMs: 25_000,
        })
        if (r.exitCode !== 0) throw new Error(cut(r.stderr || r.stdout || `exit ${r.exitCode}`, 120))
        list = parseList(r.stdout)
      } catch (err) {
        // One line per outage, not one per poll.
        if (!errorShown) {
          errorShown = true
          $.ui.log(`vercel-deploy-status: ${err instanceof Error ? err.message : String(err)}`)
        }
        return waiting($.clock.now())
      }
      errorShown = false

      const now = $.clock.now()
      const m = merge(rows, list, now, holdMs)
      for (const d of m.started) {
        $.ui.toast(`▲ ${project}: deploy started (${targetOf(d)})`)
        pushedAt = null // the deploy we were waiting for is here
      }
      for (const d of m.finished) {
        $.ui.toast(`▲ ${project}: ${LABEL[d.state]} after ${elapsed((d.ready ?? now) - d.createdAt)}`, {
          timeoutMs: 8000,
        })
      }
      rows = m.rows
      return inFlightRows().length > 0 || waiting(now)
    }

    let timer: Timer | null = null
    const loop = async () => {
      const active = await poll()
      $.ui.invalidate('ui.render')
      timer = $.clock.after(active ? activeMs : idleMs, loop)
    }

    // A push cancels the pending idle wait and looks now.
    wake = () => {
      pushedAt = $.clock.now()
      $.ui.invalidate('ui.render')
      timer?.cancel()
      timer = null
      void loop()
    }

    // The clocks on the band tick between polls.
    $.clock.every(1000, () => {
      if (rows.length > 0 || waiting($.clock.now())) $.ui.invalidate('ui.render')
    })
    void loop()

    return next(e)
  })
}
