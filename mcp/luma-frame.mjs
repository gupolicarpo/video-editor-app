import { readFileSync, writeFileSync } from 'fs'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const S = JSON.parse(readFileSync('C:/Users/gupol/AppData/Roaming/video-editor-app/settings.json', 'utf-8'))
const base = S.lumaBaseUrl.replace(/\/$/, '')
const IMG = 'C:/Users/gupol/Documents/Video_Editor_App/images'
const G = 'C:/Users/gupol/AppData/Roaming/video-editor-app/generated'
const OUT = `${G}/first-frame.png`

const studio = readFileSync(`${IMG}/studio.png`).toString('base64')
const avatar = readFileSync(`${IMG}/meu_avatar.png`).toString('base64')

const PROMPT =
  'Place this exact man (from the reference image) sitting in the center of this room, facing the camera in a medium shot from the chest up, as if recording a talking-head video. Keep his exact face, beard, black beanie, hoop earrings and black t-shirt — same identity. Light him naturally so he blends into the room\'s moody purple and blue ambient lighting. Photorealistic, cinematic, high quality.'

async function main() {
  const body = {
    type: 'image_edit',
    model: 'uni-1-max',
    prompt: PROMPT,
    source: { data: studio, media_type: 'image/png' },
    image_ref: [{ data: avatar, media_type: 'image/png' }]
  }
  console.log('enviando image_edit (você + estúdio)...')
  const r = await fetch(`${base}/v1/generations`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + S.lumaApiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  const txt = await r.text()
  if (!r.ok) { console.log('ERRO HTTP', r.status, ':', txt.slice(0, 800)); return }
  const id = JSON.parse(txt).id
  console.log('   id:', id)
  for (let i = 0; i < 100; i++) {
    await sleep(5000)
    const t = await (await fetch(`${base}/v1/generations/${id}`, { headers: { Authorization: 'Bearer ' + S.lumaApiKey } })).json()
    console.log(`   [${(i + 1) * 5}s] ${t.state}`)
    if (t.state === 'completed') {
      const url = t.output?.[0]?.url || t.assets?.image || t.image
      console.log('baixando:', String(url).slice(0, 70))
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
      writeFileSync(OUT, buf)
      console.log('PRONTO ->', OUT, (buf.length / 1024).toFixed(0), 'KB')
      return
    }
    if (t.state === 'failed') { console.log('FALHOU:', JSON.stringify(t.failure_reason || t).slice(0, 600)); return }
  }
  console.log('TIMEOUT')
}
main().catch((e) => console.log('EXCEÇÃO:', e.message))
