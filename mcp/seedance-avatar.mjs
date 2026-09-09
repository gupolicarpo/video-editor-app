import { readFileSync } from 'fs'
const S = JSON.parse(readFileSync('C:/Users/gupol/AppData/Roaming/video-editor-app/settings.json', 'utf-8'))
const base = S.seedanceBaseUrl.replace(/\/$/, '')
const model = S.seedanceModel
const img = readFileSync('C:/Users/gupol/Documents/Video_Editor_App/meu_avatar.png').toString('base64')
const dataUrl = 'data:image/png;base64,' + img

// Try a couple of content shapes; report the first error/acceptance.
const shapes = [
  { label: 'image_url role=first_frame', item: { type: 'image_url', role: 'first_frame', image_url: { url: dataUrl } } },
  { label: 'image_url (no role)', item: { type: 'image_url', image_url: { url: dataUrl } } }
]
for (const sh of shapes) {
  const body = {
    model,
    content: [{ type: 'text', text: 'A pessoa da imagem como apresentador, leve movimento natural, olhando para a câmera.' }, sh.item],
    resolution: '720p',
    ratio: '16:9',
    duration: 5,
    watermark: false
  }
  const r = await fetch(`${base}/contents/generations/tasks`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + S.seedanceApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const t = await r.text()
  let code = ''
  try { code = JSON.parse(t).error?.code || (JSON.parse(t).id ? 'ACEITOU id=' + JSON.parse(t).id : '') } catch {}
  const realperson = /real person|Sensitive|Privacy/i.test(t)
  console.log(`[${sh.label}] HTTP ${r.status} | ${realperson ? '🚫 PESSOA REAL BLOQUEADA' : code} | ${t.slice(0, 200)}`)
  if (realperson || code.startsWith('ACEITOU')) break // got our answer
}
