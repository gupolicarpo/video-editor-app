import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

let api

test.before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vedit-transcribe-test-'))
  const outfile = join(dir, 'transcribe.mjs')
  const source = await readFile(join(process.cwd(), 'src', 'main', 'transcribe.ts'), 'utf8')
  await build({
    stdin: { contents: source, loader: 'ts', sourcefile: 'transcribe.ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile
  })
  api = await import(`data:text/javascript;base64,${(await readFile(outfile)).toString('base64')}`)
})

function transcript(words, language = 'en') {
  return { language, duration: words.at(-1)?.end || 0, words, phrases: [] }
}

test('preserva o silêncio máximo escolhido em vez de reduzir a pausa a 0,08s', () => {
  const dead = api.findDeadRanges(
    transcript([
      { start: 0, end: 1, text: 'one' },
      { start: 2, end: 3, text: 'two' }
    ]),
    { removeFillers: false, maxSilence: 0.6 }
  )

  assert.deepEqual(dead, [{ start: 1.3, end: 1.7, reason: 'silence' }])
  assert.ok(Math.abs((dead[0].start - 1) + (2 - dead[0].end) - 0.6) < 0.001)
})

test('não corta filler colado a palavras vizinhas', () => {
  const dead = api.findDeadRanges(
    transcript([
      { start: 0, end: 1, text: 'we' },
      { start: 1.02, end: 1.2, text: 'uh' },
      { start: 1.23, end: 1.6, text: 'continue' }
    ]),
    { maxSilence: 0.6 }
  )

  assert.deepEqual(dead, [])
})

test('corta filler isolado usando pontos seguros dentro das pausas', () => {
  const dead = api.findDeadRanges(
    transcript([
      { start: 0, end: 1, text: 'we' },
      { start: 1.3, end: 1.5, text: 'uh' },
      { start: 1.8, end: 2.2, text: 'continue' }
    ]),
    { maxSilence: 0.6 }
  )

  assert.equal(dead.length, 1)
  assert.equal(dead[0].reason, 'filler')
  assert.equal(dead[0].text, 'uh')
  assert.ok(Math.abs(dead[0].start - 1.12) < 0.001)
  assert.ok(Math.abs(dead[0].end - 1.68) < 0.001)
  assert.ok(dead[0].start >= 1 + 0.12)
  assert.ok(dead[0].end <= 1.8 - 0.12)
})
