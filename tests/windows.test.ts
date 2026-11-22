import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

// Windows: the same mod, with hooks/windows.ps1 doing what curl, ffmpeg and pkill do on a Mac.

const KEY = 'test-fish-key'
const HOME = 'C:\\Users\\me'
const DATA = `${HOME}\\.claude\\claudespeak`
const ENV_FILE = `${DATA}\\.env`
const CURRENT = `${DATA}\\current-speech`
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const TTS = 'https://api.fish.audio/v1/tts'

type World = {
  runs: (readonly string[])[]
  stdins: (string | undefined)[]
  toasts: string[]
  writes: { path: string; text: string }[]
  files: Map<string, string>
  started: Promise<void>
  endStream: () => void
  /** Resolves once the mod has read the claim file after the player ended. */
  claimChecked: Promise<void>
}

const ran = (exitCode = 0, stderr = ''): ProcessRunResult => ({
  exitCode,
  stdout: '',
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const isAction = (argv: readonly string[], action: string): boolean => {
  const at = argv.indexOf('-Action')
  return argv[0] === PS && at > 0 && argv[at + 1] === action
}

const argAfter = (argv: readonly string[], name: string): string | undefined => argv[argv.indexOf(name) + 1]

/** Everything beneath the plugin on a Windows PC, answered from memory: no speaker, no network, no credits. */
const world = (
  on: On,
  opts: {
    envText?: string
    stderr?: string
    exitCode?: number
    /** What the claim file says once the player ends: its own tag unless another voice took over. */
    claimAfter?: string
  } = {},
): World => {
  mock.clock(on, { now: 1_000 })
  mock.store(on)
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: HOME, TEMP: 'C:\\Temp\\', SystemRoot: 'C:\\Windows' })
  const files = new Map<string, string>()
  if (opts.envText !== undefined) files.set(ENV_FILE, opts.envText)
  let started: () => void = () => undefined
  let endStream: () => void = () => undefined
  let claimChecked: () => void = () => undefined
  let hasPlayerEnded = false
  const streamEnded = new Promise<void>(resolve => {
    endStream = resolve
  })
  const w: World = {
    runs: [],
    stdins: [],
    toasts: [],
    writes: [],
    files,
    started: new Promise(resolve => {
      started = resolve
    }),
    endStream: () => endStream(),
    claimChecked: new Promise(resolve => {
      claimChecked = resolve
    }),
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.write', ($, e) => {
    w.writes.push({ path: e.path, text: e.text })
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    if (hasPlayerEnded && e.path === CURRENT) claimChecked()
    const text = files.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('process.run', async ($, e) => {
    w.runs.push(e.argv)
    w.stdins.push(e.init?.stdin)
    if (isAction(e.argv, 'play')) {
      // The script claims the speech first, as the real one does.
      const tag = argAfter(e.argv, '-Tag') ?? ''
      files.set(argAfter(e.argv, '-Current') ?? '', tag)
      started()
      if (opts.stderr === undefined && opts.exitCode === undefined) await streamEnded
      if (opts.claimAfter !== undefined) files.set(CURRENT, opts.claimAfter)
      hasPlayerEnded = true
      return { value: ran(opts.exitCode ?? (opts.stderr === undefined ? 0 : 22), opts.stderr ?? '') }
    }
    return { value: ran() }
  })
  on('model.complete', () => ({
    value: {
      isAnswered: true as const,
      text: 'I fixed the login bug and the tests pass now.',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return w
}

const answerTurn = (answer: string) => ({
  answer,
  durationMs: 1200,
  isAborted: false,
  turnId: 'turn-1',
  reason: 'answer' as const,
})

const cmd = (command: string, args = '') => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 80 },
})

/** Lets the hooks' unawaited work run to its end. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

const plays = (w: World) => w.runs.filter(run => isAction(run, 'play'))

describe('on Windows', () => {
  test('the first reply with no key writes the .env in the profile and opens it in Notepad', async ($, on) => {
    const w = world(on)
    const notice = new Promise<string>(resolve => {
      on('session.append', ($, e, next) => {
        resolve(JSON.stringify(e.message.content))
        return next(e)
      })
    })
    await $.session.start({ cwd: 'C:\\work', surface: 'desktop', isInteractive: true })
    await $.turn.complete(answerTurn('Done.'))
    const appended = await notice
    expect(w.writes.find(write => write.path === ENV_FILE)?.text).toContain('FISH_API_KEY=')
    const open = w.runs.find(run => isAction(run, 'open'))
    expect(open?.slice(-2)).toEqual(['-Path', ENV_FILE])
    expect(open?.includes('-File')).toBe(true)
    expect(argAfter(open ?? [], '-File')?.endsWith('hooks\\windows.ps1')).toBe(true)
    expect(w.runs.some(run => run[0]?.startsWith('/'))).toBe(false)
    expect(w.toasts.some(t => t.includes(ENV_FILE) && t.includes('Opened'))).toBe(true)
    expect(appended).toContain('claudespeak')
    expect(plays(w).length).toBe(0)
  })

  test('/speak key opens the .env that is there, and never prints the key', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    await $.session.start({ cwd: 'C:\\work', surface: 'desktop', isInteractive: true })
    const said = await $.command.run(cmd('speak', 'key'))
    expect(said.text).toContain(ENV_FILE)
    expect(said.text).not.toContain(KEY)
    expect(w.runs.some(run => isAction(run, 'open'))).toBe(true)
    expect(w.writes.some(write => write.path === ENV_FILE)).toBe(false)
  })

  test('a reply is fetched and played by the script, the key on its standard input only', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    await $.session.start({ cwd: 'C:\\work', surface: 'desktop', isInteractive: true })
    await $.turn.complete(answerTurn('Done. All tests pass.'))
    await w.started
    const run = plays(w)[0] ?? []
    const at = w.runs.indexOf(run)
    expect(argAfter(run, '-Tag')).toBe('claudespeak-1000')
    expect(argAfter(run, '-Body')).toBe('C:\\Temp\\claudespeak-1000.json')
    expect(argAfter(run, '-Url')).toBe(TTS)
    expect(argAfter(run, '-Model')).toBe('drama-3')
    expect(argAfter(run, '-Current')).toBe(CURRENT)
    expect(argAfter(run, '-Rate')).toBe('44100')
    expect(run.join(' ')).not.toContain(KEY)
    expect(w.stdins[at]).toBe(`Bearer ${KEY}\n`)
    const sent = JSON.parse(w.files.get('C:\\Temp\\claudespeak-1000.json') ?? '{}') as { text: string; format: string }
    expect(sent.text).toBe('Done. All tests pass.')
    expect(sent.format).toBe('pcm')
    expect(w.runs.some(r => r[0] === '/usr/bin/which' || r.includes('/opt/homebrew/bin/ffmpeg'))).toBe(false)
    w.endStream()
  })

  test('the voice comes from the config', { options: { voiceId: 'v-laura' } }, async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    await $.session.start({ cwd: 'C:\\work', surface: 'desktop', isInteractive: true })
    await $.turn.complete(answerTurn('Done.'))
    await w.started
    const sent = JSON.parse(w.files.get('C:\\Temp\\claudespeak-1000.json') ?? '{}') as { reference_id: string }
    expect(sent.reference_id).toBe('v-laura')
    w.endStream()
  })

  test('/speak stop stops every voice on the computer', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    await $.session.start({ cwd: 'C:\\work', surface: 'desktop', isInteractive: true })
    await $.turn.complete(answerTurn('Done.'))
    await w.started
    expect((await $.command.run(cmd('speak', 'stop'))).text).toBe('Stopped speaking.')
    const stops = w.runs.filter(run => isAction(run, 'stop'))
    expect(stops.some(run => run.at(-1) === 'stop')).toBe(true)
    expect(w.files.get(CURRENT)).toBe('stopped 1000')
    w.endStream()
  })

  test('a new prompt stops this session\'s voice by its tag', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    await $.session.start({ cwd: 'C:\\work', surface: 'desktop', isInteractive: true })
    await $.turn.complete(answerTurn('Done.'))
    await w.started
    await $.prompt.submit({ text: 'next thing', wait: false, origin: { kind: 'composer' } })
    await settle()
    const stop = w.runs.find(run => isAction(run, 'stop'))
    expect(stop?.slice(-2)).toEqual(['-Tag', 'claudespeak-1000'])
    w.endStream()
  })

  test('a Fish refusal says so in a toast', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}`, stderr: 'returned error: 402' })
    await $.session.start({ cwd: 'C:\\work', surface: 'desktop', isInteractive: true })
    await $.turn.complete(answerTurn('Done.'))
    await w.started
    await settle()
    expect(w.toasts.some(t => t.includes('out of credits'))).toBe(true)
    expect(w.toasts.join(' ')).not.toContain(KEY)
  })

  test('a player that fails says why', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}`, exitCode: 1, stderr: 'playback: no sound device' })
    await $.session.start({ cwd: 'C:\\work', surface: 'desktop', isInteractive: true })
    await $.turn.complete(answerTurn('Done.'))
    await w.started
    await w.claimChecked
    await settle()
    expect(w.toasts).toContain('claudespeak: playback failed: playback: no sound device')
  })

  test('a voice another session cut off is no failure', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}`, exitCode: 4294967295, claimAfter: 'claudespeak-2000' })
    await $.session.start({ cwd: 'C:\\work', surface: 'desktop', isInteractive: true })
    await $.turn.complete(answerTurn('Done.'))
    await w.started
    await w.claimChecked
    await settle()
    expect(w.toasts.some(t => t.includes('playback failed'))).toBe(false)
  })

  test('/speak off writes the setting in the profile and stops every voice', async ($, on) => {
    const w = world(on, { envText: `FISH_API_KEY=${KEY}` })
    await $.session.start({ cwd: 'C:\\work', surface: 'desktop', isInteractive: true })
    expect((await $.command.run(cmd('speak', 'off'))).text).toBe('Spoken replies are off in every session.')
    expect(w.writes).toContainEqual({ path: `${DATA}\\setting.json`, text: '{"isOn":false}' })
    expect(w.runs.some(run => isAction(run, 'stop'))).toBe(true)
    expect(w.runs.some(run => run[0] === '/bin/mkdir')).toBe(false)
  })
})
