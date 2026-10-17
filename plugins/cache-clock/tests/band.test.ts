import { expect, mock, test } from 'claude-code/testing'

import { handoffPath, lastLines, pickAction, tailCommand } from '../hooks/register'

test('the band draws one line', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  on('ui.render', () => null)
  const ui = await $.ui.mount({ plugin: 'cache-clock', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 } } } as any)
  expect(await ui.find({ type: 'Text', text: /cache/ } as any)).toBeDefined()
})

test('the warning action comes from the env var, then the old switch, then the setting', async () => {
  expect(pickAction(undefined, undefined, undefined)).toBe('handoff')
  expect(pickAction(undefined, undefined, 'off')).toBe('off')
  expect(pickAction(undefined, '0', 'handoff')).toBe('off')
  expect(pickAction('handoff', '0', 'off')).toBe('handoff')
  // compact is gone (Claude Code's idle compaction does it); an old saved value means off
  expect(pickAction(undefined, undefined, 'compact')).toBe('off')
  expect(pickAction('compact', undefined, 'handoff')).toBe('off')
  expect(pickAction('nonsense', undefined, undefined)).toBe('handoff')
})

test('each session gets its own handoff note', async () => {
  expect(handoffPath('/w/proj', '1a2b3c4d-5e6f-7a8b-9c0d-ef0123456789')).toBe('/w/proj/HANDOFF-1a2b3c4d.md')
  expect(handoffPath('/w/notes/', '9f8e7d6c-0000')).toBe('/w/notes/HANDOFF-9f8e7d6c.md')
})

test('a Windows handoff folder with a trailing backslash gets one separator', async () => {
  expect(handoffPath('C:\\proj\\', '1a2b3c4d-0000')).toBe('C:\\proj/HANDOFF-1a2b3c4d.md')
})

test('lastLines takes the end of LF and CRLF text, like tail -n', async () => {
  expect(lastLines('a\nb\nc\n', 2)).toEqual(['b', 'c'])
  expect(lastLines('a\r\nb\r\nc\r\n', 2)).toEqual(['b', 'c'])
  expect(lastLines('a\nb', 5)).toEqual(['a', 'b'])
  expect(lastLines('', 3)).toEqual([])
})

test('tail reads the end on Mac and Linux; PowerShell on Windows, with the path in an env var', async () => {
  expect(tailCommand(false, '/t/s.jsonl')).toEqual([['tail', '-n', '300', '/t/s.jsonl'], {}])
  const path = "C:\\Users\\U\\.claude\\projects\\p\\a'b.jsonl"
  const [argv, init] = tailCommand(true, path)
  expect(argv.slice(0, 4)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-Command'])
  expect(argv[4]).not.toContain(path)
  expect(init).toEqual({ env: { CACHE_CLOCK_FILE: path } })
})

// Headless (-p, SDK): no band timer and no /cache-clock command. The timer is
// what would submit handoff turns, so it must not exist without a person.
test('headless session starts no timer and no command', async ($, on) => {
  mock.store(on, {})
  mock.env(on, {})
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  let timers = 0
  let commands = 0
  on('clock.every', () => { timers += 1; return { value: undefined } as never })
  on('command.register', () => { commands += 1; return { value: undefined } as never })
  await $.session.start({ cwd: '/nowhere', surface: 'terminal', isInteractive: false })
  expect(timers).toBe(0)
  expect(commands).toBe(0)
})

// Positive control: the same probes fire in an interactive session, so the
// headless test above cannot pass just because the event names are wrong.
test('interactive session starts the timer and the command', async ($, on) => {
  mock.store(on, {})
  mock.env(on, {})
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { context: 0 } }) as never)
  let timers = 0
  let commands = 0
  on('clock.every', () => { timers += 1; return { value: undefined } as never })
  on('command.register', () => { commands += 1; return { value: undefined } as never })
  await $.session.start({ cwd: '/nowhere', surface: 'terminal', isInteractive: true })
  expect(timers).toBe(1)
  expect(commands).toBe(1)
})
