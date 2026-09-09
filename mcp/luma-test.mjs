import { readFileSync, writeFileSync } from 'fs'
import { spawn } from 'child_process'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const S = JSON.parse(readFileSync('C:/Users/gupol/AppData/Roaming/video-editor-app/settings.json', 'utf-8'))
if (!S.lumaApiKey) { console.log('SEM CHAVE LUMA — cole em Configurações → Luma e rode de novo.'); process.exit(0) }
const base = S.lumaBaseUrl.replace(/\/$/, '')
const model = S.lumaModel || 'ray-3.2'
const SRC = 'C:/Users/gupol/AppData/Roaming/video-editor-app/generated/graded-match.mp4'
const SEG = 'C:/Users/gupol/AppData/Roaming/video-editor-app/generated/_luma_seg.mp4'
const OUT = 'C:/Users/gupol/AppData/Roaming/video-editor-app/generated/luma-edit-test.mp4'
const PROMPT = 'Relight this person with soft professional studio lighting and natural warm skin tones; keep the same face, performance and the purple studio background; crisp, cinematic, high-end look.'

function run(cmd, args) {
  return new Promise((res, rej) => { const p = spawn(cmd, args); let e = ''; p.stderr.on('data', (d) => (e += d)); p.on('close', (c) => (c === 0 ? res() : rej(new Error(e.slice(-500))))) })
}
async function main() {
  console.log('1/4 extraindo trecho de 5s...')
  await run('ffmpeg', ['-y', '-i', SRC, '-t', '5', '-vf', 'scale=1280:-2', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', SEG])
  const b64 = readFileSync(SEG).toString('base64')
  console.log('   trecho base64:', (b64.length / 1024 / 1024).toFixed(2), 'MB')

  const body = {
    type: 'video_edit', model, prompt: PROMPT, aspect_ratio: '16:9',
    source: { data: b64, media_type: 'video/mp4' },
    video: { resolution: '720p', duration: '5s' }
  }
  console.log('2/4 enviando video_edit...')
  const r = await fetch(`${base}/v1/generations`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + S.lumaApiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  const txt = await r.text()
  if (!r.ok) { console.log('ERRO HTTP', r.status, ':', txt.slice(0, 600)); return }
  const sub = JSON.parse(txt)
  const id = sub.id || sub.generation_id
  console.log('   id:', id, '| estado:', sub.state)
  console.log('3/4 aguardando...')
  for (let i = 0; i < 150; i++) {
    await sleep(6000)
    const t = await (await fetch(`${base}/v1/generations/${id}`, { headers: { Authorization: 'Bearer ' + S.lumaApiKey } })).json()
    console.log(`   [${(i + 1) * 6}s] ${t.state}`)
    if (t.state === 'completed') {
      const url = t.output?.[0]?.url || t.assets?.video || t.video
      console.log('4/4 baixando:', String(url).slice(0, 70))
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
      writeFileSync(OUT, buf)
      console.log('PRONTO ->', OUT, (buf.length / 1024 / 1024).toFixed(2), 'MB')
      return
    }
    if (t.state === 'failed') { console.log('FALHOU:', JSON.stringify(t.failure_reason || t).slice(0, 500)); return }
  }
  console.log('TIMEOUT')
}
main().catch((e) => console.log('EXCEÇÃO:', e.message))
