import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

let api

test.before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vedit-ripple-trim-test-'))
  const outfile = join(dir, 'ripple-trim.mjs')
  const source = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'rippleTrim.ts'), 'utf8')
  await build({
    stdin: { contents: source, loader: 'ts', sourcefile: 'rippleTrim.ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile
  })
  api = await import(`data:text/javascript;base64,${(await readFile(outfile)).toString('base64')}`)
})

const clip = (id, start, duration, trackId = 'v1') => ({ id, start, duration, trackId })

test('move toda a sequência colada e preserva um espaço intencional posterior', () => {
  const clips = [clip('a', 0, 2), clip('b', 2, 3), clip('c', 5, 1), clip('gap', 7, 2)]
  const followers = api.findRippleFollowers(clips, clips[0])
  assert.deepEqual(followers, [
    { id: 'b', start: 2 },
    { id: 'c', start: 5 }
  ])

  const current = clips.map((c) => (c.id === 'a' ? { ...c, duration: 1.5 } : c))
  const result = api.finishRippleTrim(current, 'a', 0, followers, -0.5, false)
  assert.equal(result.find((c) => c.id === 'b').start, 1.5)
  assert.equal(result.find((c) => c.id === 'c').start, 4.5)
  assert.equal(result.find((c) => c.id === 'gap').start, 7)
})

test('trim pela esquerda ancora o trecho e fecha a sequência', () => {
  const clips = [clip('a', 2, 3), clip('b', 5, 2)]
  const followers = api.findRippleFollowers(clips, clips[0])
  const duringDrag = clips.map((c) => (c.id === 'a' ? { ...c, start: 3, duration: 2 } : c))
  const result = api.finishRippleTrim(duringDrag, 'a', 2, followers, -1, true)

  assert.equal(result.find((c) => c.id === 'a').start, 2)
  assert.equal(result.find((c) => c.id === 'b').start, 4)
})

test('não desloca clipes de outra faixa', () => {
  const clips = [clip('a', 0, 2), clip('b', 2, 2), clip('audio', 2, 2, 'a1')]
  const followers = api.findRippleFollowers(clips, clips[0])
  const result = api.finishRippleTrim(clips, 'a', 0, followers, 1, false)

  assert.equal(result.find((c) => c.id === 'b').start, 3)
  assert.equal(result.find((c) => c.id === 'audio').start, 2)
})
