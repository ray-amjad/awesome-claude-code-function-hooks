import { expect, test } from 'claude-code/testing'

import { handoffPath, lastLines, pickAction, SIDE_REQUEST_COMMANDS, tailCommand } from '../hooks/register'

test('the band draws one line', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  on('ui.render', () => null)
  const ui = await $.ui.mount({ plugin: 'cache-clock', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 } } } as any)
  expect(await ui.find({ type: 'Text', text: /cache/ } as any)).toBeDefined()
})

const BAND = { plugin: 'cache-clock', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 } } } as any
const MIN = 60_000
// The band's first piece: '◷ cache 10:00 left'
async function cachePiece($: any) {
  const text = (await (await $.ui.mount(BAND)).find({ type: 'Text', text: /◷/ } as any))?.text
  return String(text).split('  ·  ')[0]
}

for (const command of SIDE_REQUEST_COMMANDS) {
  test(`/${command} restarts the main cache clock, though no turn.step fires for it (#15)`, async ($, on) => {
    let now = 1_000_000
    on('clock.now', () => ({ value: now }))
    on('ui.render', () => null)
    on('turn.step', async function* (_$, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as any })
    on('command.run', () => ({ text: 'side answer' }))

    // Before any main request there is nothing cached to keep warm
    await $.command.run({ command, args: '' } as any)
    expect(await cachePiece($)).toBe('◷ cache: no request yet')

    // A main turn starts the hour; 50 minutes later 10 are left
    const step = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as any)
    for await (const _ of step);
    now += 50 * MIN
    expect(await cachePiece($)).toBe('◷ cache 10:00 left')

    // The side request reads the cache: a full hour again
    await $.command.run({ command, args: '' } as any)
    expect(await cachePiece($)).toBe('◷ cache 60:00 left')
  })
}

test('another command leaves the cache clock alone', async ($, on) => {
  let now = 1_000_000
  on('clock.now', () => ({ value: now }))
  on('ui.render', () => null)
  on('turn.step', async function* (_$, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as any })
  on('command.run', () => ({ text: 'ok' }))
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as any)
  for await (const _ of step);
  now += 50 * MIN
  await $.command.run({ command: 'cost', args: '' } as any)
  expect(await cachePiece($)).toBe('◷ cache 10:00 left')
})

test('the warning action comes from the env var, then the old switch, then the setting', async () => {
  expect(pickAction(undefined, undefined, undefined)).toBe('handoff')
  expect(pickAction(undefined, undefined, 'compact')).toBe('compact')
  expect(pickAction(undefined, '0', 'compact')).toBe('off')
  expect(pickAction('compact', '0', 'off')).toBe('compact')
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
