// Run with: node --experimental-strip-types plugins/vercel-deploy-status/test/queue.test.mts
// No runner, no dependencies. Each check is one assert.

import assert from 'node:assert/strict'
import {
  type Deployment,
  type Row,
  isDeployCommand,
  elapsed,
  cut,
  plural,
  num,
  parseList,
  header,
  clock,
  merge,
  LABEL_WIDTH,
} from '../hooks/queue.ts'

let checks = 0
const ok = (cond: boolean, what: string) => {
  checks++
  assert.ok(cond, what)
}

// --- the shell lines that wake the poll loop ------------------------------

const WAKES = [
  'git push',
  'git push origin main',
  'git push -u origin feat/x',
  'git -C /some/repo push',
  'cd apps/web && git push origin HEAD',
  'gh pr merge 1238 --squash --delete-branch',
  'vercel deploy',
  'vercel --prod',
  'npm run build && vercel --prod',
]
const SLEEPS = [
  'git pull',
  'git push --dry-run',
  'git status',
  'vercel ls --format json',
  'vercel logs --since 1h',
  'mygit push', // a different binary that happens to end in "git"
  'gh pr view 12',
  'echo pushing',
]
for (const c of WAKES) ok(isDeployCommand(c), `wakes on: ${c}`)
for (const c of SLEEPS) ok(!isDeployCommand(c), `sleeps on: ${c}`)

// --- formatters -----------------------------------------------------------

ok(elapsed(0) === '0s', 'elapsed 0')
ok(elapsed(-5000) === '0s', 'elapsed never negative')
ok(elapsed(59_000) === '59s', 'elapsed seconds')
ok(elapsed(65_000) === '1m 5s', 'elapsed minutes')
ok(elapsed(3_720_000) === '1h 2m', 'elapsed hours drop the seconds')

ok(cut('first line\nsecond line', 40) === 'first line', 'cut keeps the first line')
ok(cut('  padded  ', 40) === 'padded', 'cut trims')
ok(cut('abcdefghij', 5) === 'abcd…', 'cut ends in one ellipsis inside the limit')
ok(cut('abcde', 5) === 'abcde', 'cut leaves a line that fits')

ok(plural(1, 'more') === '1 more', 'plural one')
ok(plural(2, 'more') === '2 mores', 'plural many')

ok(num('15', 60) === 15, 'num parses a string')
ok(num(0, 60) === 60, 'num rejects zero')
ok(num('no', 60) === 60, 'num rejects junk')
ok(LABEL_WIDTH === 'Initializing'.length, 'label width is the widest label')

// --- parseList ------------------------------------------------------------

const dep = (over: Partial<Deployment>): Deployment => ({
  url: `d-${over.createdAt ?? 0}.vercel.app`,
  name: 'site',
  state: 'READY',
  target: 'production',
  createdAt: 0,
  ...over,
})

const list = parseList(
  'Vercel CLI 48.0.0\nRetrieving project…\n' +
    JSON.stringify({ deployments: [dep({ createdAt: 1 }), dep({ createdAt: 3 }), dep({ createdAt: 2 })] }),
)
ok(list.map((d) => d.createdAt).join() === '3,2,1', 'parseList skips the chatter and sorts newest first')
ok(parseList('{}').length === 0, 'parseList with no deployments is empty')
assert.throws(() => parseList('Error: not logged in'), /no JSON/)
checks++

// --- header ---------------------------------------------------------------

const row = (d: Deployment, finishedAt: number | null = null): Row => ({ d, finishedAt })

ok(header('site', []) === '▲ site', 'header with an empty queue is the project alone')
ok(
  header('site', [
    row(dep({ state: 'BUILDING', createdAt: 5 })),
    row(dep({ state: 'INITIALIZING', createdAt: 4 })),
    row(dep({ state: 'QUEUED', createdAt: 3 })),
    row(dep({ state: 'READY', createdAt: 2 }), 100),
    row(dep({ state: 'ERROR', createdAt: 1 }), 100),
  ]) === '▲ site · 2 building · 1 queued · 2 finished',
  'header counts each phase, initializing counts as building',
)

// --- clock ----------------------------------------------------------------

ok(clock(row(dep({ state: 'BUILDING', createdAt: 10_000 })), 90_000) === '1m 20s', 'clock in flight is time since start')
ok(
  clock(row(dep({ state: 'READY', createdAt: 0, ready: 123_000 }), 200_000), 440_000) === 'took 2m 3s · 4m 0s ago',
  'clock finished shows took and ago',
)
ok(
  clock(row(dep({ state: 'ERROR', createdAt: 0 }), 50_000), 60_000) === 'took 50s · 10s ago',
  'clock finished with no ready stamp uses when it left flight',
)

// --- merge ----------------------------------------------------------------

const HOLD = 5 * 60_000

// A fresh deploy appears: it is started, and it goes on the queue.
let m = merge([], [dep({ url: 'a', state: 'BUILDING', createdAt: 1 })], 1000, HOLD)
ok(m.started.length === 1 && m.started[0].url === 'a', 'merge reports a new in-flight deploy as started')
ok(m.rows.length === 1 && m.rows[0].finishedAt === null, 'merge puts it on the queue with no finish time')
ok(m.finished.length === 0, 'merge reports nothing finished on a fresh queue')

// The same deploy on the next poll: known, so not started again.
m = merge(m.rows, [dep({ url: 'a', state: 'BUILDING', createdAt: 1 })], 2000, HOLD)
ok(m.started.length === 0, 'merge does not report a known deploy twice')

// It turns READY: finished with the final state, and it keeps its line.
m = merge(m.rows, [dep({ url: 'a', state: 'READY', createdAt: 1, ready: 3000 })], 3000, HOLD)
ok(m.finished.length === 1 && m.finished[0].state === 'READY', 'merge reports the deploy finished with its final state')
ok(m.rows.length === 1 && m.rows[0].finishedAt === 3000 && m.rows[0].d.ready === 3000, 'merge keeps the finished row with the final record')

// Inside the hold window it stays; past it, it ages out.
ok(merge(m.rows, [], 3000 + HOLD, HOLD).rows.length === 1, 'merge holds a finished row to the edge of the window')
ok(merge(m.rows, [], 3001 + HOLD, HOLD).rows.length === 0, 'merge drops a finished row past the window')

// One that fails is shown as Error, not Ready.
m = merge(
  [row(dep({ url: 'b', state: 'BUILDING', createdAt: 1 }))],
  [dep({ url: 'b', state: 'ERROR', createdAt: 1 })],
  5000,
  HOLD,
)
ok(m.finished[0]?.state === 'ERROR' && m.rows[0].d.state === 'ERROR', 'merge keeps an Error as Error')

// One that fell off the list is shown as Ready.
m = merge([row(dep({ url: 'c', state: 'QUEUED', createdAt: 1 }))], [], 5000, HOLD)
ok(m.finished[0]?.state === 'READY' && m.rows[0].finishedAt === 5000, 'merge assumes Ready for a deploy that left the list')

// Finished deploys that were never watched do not appear.
m = merge([], [dep({ url: 'old', state: 'READY', createdAt: 1 })], 5000, HOLD)
ok(m.rows.length === 0 && m.finished.length === 0, 'merge ignores a deploy that finished before we looked')

// The queue is newest first, whatever order the list came in.
m = merge(
  [],
  [dep({ url: 'x', state: 'QUEUED', createdAt: 1 }), dep({ url: 'y', state: 'BUILDING', createdAt: 9 }), dep({ url: 'z', state: 'QUEUED', createdAt: 5 })],
  10,
  HOLD,
)
ok(m.rows.map((r) => r.d.url).join('') === 'yzx', 'merge sorts newest first')

console.log(`ok  ${checks} checks passed`)
