import { readFileSync, writeFileSync } from 'fs'
import { spawn } from 'child_process'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const S = JSON.parse(readFileSync('C:/Users/gupol/AppData/Roaming/video-editor-app/settings.json', 'utf-8'))
const base = S.lumaBaseUrl.replace(/\/$/, '')
const model = S.lumaModel || 'ray-3.2'
const MODE = process.argv[2] || 'flex_1'
const DUR = Number(process.argv[3] || 5)
const G = 'C:/Users/gupol/AppData/Roaming/video-editor-app/generated'
const SRC = `${G}/graded-match.mp4`
const FRAME = `${G}/first-frame-169.png`
const SEG = `${G}/_luma_segF.mp4`
const SILENT = `${G}/_luma_silentF.mp4`
const OUT = `${G}/luma-estudio-${MODE}-${DUR}s.mp4`
const PROMPT =
  'Place this man in the moody music studio room shown in the first frame, with the plant, vinyl records, synthesizer, lamps and purple-blue ambient lighting. Keep his exact identity, face, beard, black beanie, earrings and black t-shirt, and keep all his motion and mouth movements from the source. Photorealistic, cinematic, consistent lighting on his face matching the room.'

function run(cmd, args) {
  return new Promise((res, rej) => { const p = spawn(cmd, args); let e = ''; p.stderr.on('data', (d) => (e += d)); p.on('close', (c) => (c === 0 ? res() : rej(new Error(e.slice(-600))))) })
}
async function main() {
  console.log(`pipeline final: mode=${MODE} dur=${DUR}s`)
  await run('ffmpeg', ['-y', '-i', SRC, '-t', String(DUR), '-vf', 'scale=1280:-2', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', SEG])
  const vid = readFileSync(SEG).toString('base64')
  const frame = readFileSync(FRAME).toString('base64')
  const body = {
    type: 'video_edit', model, prompt: PROMPT, aspect_ratio: '16:9', mode: MODE,
    source: { data: vid, media_type: 'video/mp4' },
    first_frame: { data: frame, media_type: 'image/png' },
    video: { resolution: '720p', duration: `${DUR}s` }
  }
  console.log('enviando video_edit (com first_frame)...')
  const r = await fetch(`${base}/v1/generations`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + S.lumaApiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  const txt = await r.text()
  if (!r.ok) { console.log('ERRO HTTP', r.status, ':', txt.slice(0, 800)); return }
  const id = JSON.parse(txt).id
  console.log('   id:', id)
  let url = null
  for (let i = 0; i < 180; i++) {
    await sleep(6000)
    const t = await (await fetch(`${base}/v1/generations/${id}`, { headers: { Authorization: 'Bearer ' + S.lumaApiKey } })).json()
    console.log(`   [${(i + 1) * 6}s] ${t.state}`)
    if (t.state === 'completed') { url = t.output?.[0]?.url; break }
    if (t.state === 'failed') { console.log('FALHOU:', JSON.stringify(t.failure_reason || t).slice(0, 600)); return }
  }
  if (!url) { console.log('TIMEOUT'); return }
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
  writeFileSync(SILENT, buf)
  await run('ffmpeg', ['-y', '-i', SILENT, '-i', SEG, '-map', '0:v:0', '-map', '1:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-shortest', OUT])
  console.log('PRONTO ->', OUT)
}
main().catch((e) => console.log('EXCEÇÃO:', e.message))
