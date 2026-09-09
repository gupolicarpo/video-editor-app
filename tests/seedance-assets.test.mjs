import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

test('preserva asset:// para referencias confiaveis da ModelArk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vedit-seedance-asset-test-'))
  const outfile = join(dir, 'seedance-request.mjs')
  const source = await readFile(join(process.cwd(), 'src', 'main', 'ai', 'seedanceRequest.ts'), 'utf8')
  await build({
    stdin: { contents: source, loader: 'ts', sourcefile: 'seedanceRequest.ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile
  })
  const api = await import(`data:text/javascript;base64,${(await readFile(outfile)).toString('base64')}`)
  const body = api.buildSeedanceRequest({
    model: 'dreamina-seedance-2-0-260128',
    prompt: 'Use o movimento do personagem confiavel',
    images: [{ url: 'asset://image-character', role: 'reference_image' }],
    videos: ['asset://video-motion'],
    generateAudio: false
  })

  assert.equal(body.content[1].image_url.url, 'asset://image-character')
  assert.equal(body.content[2].video_url.url, 'asset://video-motion')
})
