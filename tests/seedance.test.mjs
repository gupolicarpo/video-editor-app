import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

let api

test.before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vedit-seedance-test-'))
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
  api = await import(`data:text/javascript;base64,${(await readFile(outfile)).toString('base64')}`)
})

test('envia os papéis multimodais e o áudio explicitamente desligado', () => {
  const body = api.buildSeedanceRequest({
    model: 'dreamina-seedance-2-0-260128',
    prompt: 'Use o movimento do vídeo 1',
    images: [{ url: 'data:image/png;base64,AA==', role: 'reference_image' }],
    videos: ['https://example.com/reference.mp4'],
    audios: ['data:audio/mpeg;base64,AA=='],
    resolution: '1080p',
    ratio: '21:9',
    duration: -1,
    generateAudio: false
  })

  assert.equal(body.generate_audio, false)
  assert.equal(body.duration, -1)
  assert.deepEqual(
    body.content.map((item) => item.role).filter(Boolean),
    ['reference_image', 'reference_video', 'reference_audio']
  )
})

test('aceita primeiro e último quadro sem referências multimodais', () => {
  const body = api.buildSeedanceRequest({
    model: 'dreamina-seedance-2-0-260128',
    prompt: 'Transição suave',
    images: [
      { url: 'data:image/png;base64,AA==', role: 'first_frame' },
      { url: 'data:image/png;base64,BB==', role: 'last_frame' }
    ],
    generateAudio: true,
    returnLastFrame: true
  })

  assert.equal(body.return_last_frame, true)
  assert.equal(body.generate_audio, true)
})

test('recusa misturar quadros de início/fim com vídeo de referência', () => {
  assert.throws(
    () =>
      api.buildSeedanceRequest({
        model: 'dreamina-seedance-2-0-260128',
        prompt: 'Teste',
        images: [{ url: 'data:image/png;base64,AA==', role: 'first_frame' }],
        videos: ['https://example.com/reference.mp4'],
        generateAudio: false
      }),
    /não pode ser misturado/
  )
})

test('aplica as resoluções reais dos modelos standard, fast e mini', () => {
  assert.deepEqual(api.seedanceResolutions('dreamina-seedance-2-0-260128'), ['480p', '720p', '1080p', '4k'])
  assert.deepEqual(api.seedanceResolutions('dreamina-seedance-2-0-fast-260128'), ['480p', '720p'])
  assert.deepEqual(api.seedanceResolutions('dreamina-seedance-2-0-mini-260615'), ['480p', '720p'])
  assert.throws(
    () =>
      api.buildSeedanceRequest({
        model: 'dreamina-seedance-2-0-fast-260128',
        prompt: 'Teste',
        resolution: '1080p',
        generateAudio: false
      }),
    /não aceita resolução/
  )
})

test('recusa referências além dos limites oficiais', () => {
  assert.throws(
    () =>
      api.buildSeedanceRequest({
        model: 'dreamina-seedance-2-0-260128',
        prompt: 'Teste',
        videos: Array.from({ length: 4 }, (_, index) => `https://example.com/${index}.mp4`),
        generateAudio: false
      }),
    /no máximo 3 vídeos/
  )
})

test('explicita no prompt o papel do vídeo em cada modo', () => {
  assert.equal(
    api.seedancePromptForMode('motion', 'Faça um robô caminhar.'),
    'Use o Vídeo 1 como referência de movimento e câmera. Faça um robô caminhar.'
  )
  assert.match(api.seedancePromptForMode('connect', 'Sem corte visível.'), /Vídeo 1 ao Vídeo 2/)
})
