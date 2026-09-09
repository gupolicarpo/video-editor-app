import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

let api

test.before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vedit-seedream-character-test-'))
  const outfile = join(dir, 'seedream-request.mjs')
  const source = await readFile(
    join(process.cwd(), 'src', 'main', 'ai', 'seedreamRequest.ts'),
    'utf8'
  )
  await build({
    stdin: { contents: source, loader: 'ts', sourcefile: 'seedreamRequest.ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile
  })
  api = await import(`data:text/javascript;base64,${(await readFile(outfile)).toString('base64')}`)
})

test('prepara personagem com Seedream 5 Lite e preserva a URL original', () => {
  const body = api.buildSeedreamCharacterRequest('data:image/png;base64,AA==')

  assert.equal(body.model, 'seedream-5-0-lite-260128')
  assert.equal(body.image, 'data:image/png;base64,AA==')
  assert.equal(body.response_format, 'url')
  assert.equal(body.output_format, 'png')
  assert.equal(body.watermark, false)
  assert.match(body.prompt, /Preserve exactly the identity/)

  const originalUrl = 'https://ark.example.com/original-seedream-output.png'
  assert.equal(api.seedreamOutputUrl({ data: [{ url: originalUrl }] }), originalUrl)
})

test('recusa resposta Seedream sem URL HTTPS original', () => {
  assert.throws(() => api.seedreamOutputUrl({ data: [{}] }), /URL original/)
  assert.throws(
    () => api.seedreamOutputUrl({ data: [{ url: 'data:image/png;base64,AA==' }] }),
    /URL original/
  )
})
