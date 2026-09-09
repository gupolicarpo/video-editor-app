import { readFileSync, writeFileSync } from 'fs'
import { spawn } from 'child_process'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const S = JSON.parse(readFileSync('C:/Users/gupol/AppData/Roaming/video-editor-app/settings.json', 'utf-8'))
if (!S.lumaApiKey) { console.log('SEM CHAVE LUMA'); process.exit(0) }
const base = S.lumaBaseUrl.replace(/\/$/, '')
const model = S.lumaModel || 'ray-3.2'
const DUR = Number(process.argv[2] || 10) // segundos
const G = 'C:/Users/gupol/AppData/Roaming/video-editor-app/generated'
const SRC = `${G}/graded-match.mp4`
const SEG = `${G}/_luma_seg3.mp4`
const SILENT = `${G}/_luma_silent3.mp4`
const OUT = `${G}/luma-com-audio-${DUR}s.mp4`
const PROMPT =
  'Keep this exact man unchanged — same face, same beard, same black beanie, same black t-shirt, sitting in the same room. Do NOT change his identity, body, clothing or the scene. Only improve the lighting: add a soft professional studio key light from the front-left, gentle fill light, natural warm and even skin tones, slightly brighter and more flattering. Photorealistic, crisp, cinematic, high-end. Same camera, same composition, same motion, same mouth movements.'

function run(cmd, args) {
  return new Promise((res, rej) => { const p = spawn(cmd, args); let e = ''; p.stderr.on('data', (d) => (e += d)); p.on('close', (c) => (c === 0 ? res() : rej(new Error(e.slice(-600))))) })
}
async function main() {
  console.log(`1/5 extraindo trecho de ${DUR}s...`)
  await run('ffmpeg', ['-y', '-i', SRC, '-t', String(DUR), '-vf', 'scale=1280:-2', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', SEG])
  const b64 = readFileSync(SEG).toString('base64')
  console.log('   base64:', (b64.length / 1024 / 1024).toFixed(2), 'MB')

  const body = {
    type: 'video_edit', model, prompt: PROMPT, aspect_ratio: '16:9',
    source: { data: b64, media_type: 'video/mp4' },
    video: { resolution: '720p', duration: `${DUR}s` }
  }
  console.log('2/5 enviando video_edit...')
  const r = await fetch(`${base}/v1/generations`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + S.lumaApiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  const txt = await r.text()
  if (!r.ok) { console.log('ERRO HTTP', r.status, ':', txt.slice(0, 700)); return }
  const sub = JSON.parse(txt)
  const id = sub.id || sub.generation_id
  console.log('   id:', id, '| estado:', sub.state)
  console.log('3/5 aguardando...')
  let url = null
  for (let i = 0; i < 200; i++) {
    await sleep(6000)
    const t = await (await fetch(`${base}/v1/generations/${id}`, { headers: { Authorization: 'Bearer ' + S.lumaApiKey } })).json()
    console.log(`   [${(i + 1) * 6}s] ${t.state}`)
    if (t.state === 'completed') { url = t.output?.[0]?.url || t.assets?.video || t.video; break }
    if (t.state === 'failed') { console.log('FALHOU:', JSON.stringify(t.failure_reason || t).slice(0, 500)); return }
  }
  if (!url) { console.log('TIMEOUT'); return }
  console.log('4/5 baixando vídeo (mudo)...')
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
  writeFileSync(SILENT, buf)
  console.log('5/5 colando áudio original...')
  await run('ffmpeg', ['-y', '-i', SILENT, '-i', SEG, '-map', '0:v:0', '-map', '1:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-shortest', OUT])
  console.log('PRONTO ->', OUT)
}
main().catch((e) => console.log('EXCEÇÃO:', e.message))
