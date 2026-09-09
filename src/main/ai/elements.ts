import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { loadSettings } from '../settings'

/**
 * Generate an overlay element (icon / sticker / badge) as a PNG with a real
 * transparent background, so it composites over footage without a matte pass.
 *
 * Uses OpenAI's image API, which is the only provider configured here that
 * accepts `background: 'transparent'` — the whole point for overlays. A normal
 * text-to-image would come back on a solid square and be useless as a sticker.
 */

export interface GenerateElementPayload {
  prompt: string
  size?: '1024x1024' | '1536x1024' | '1024x1536'
  outDir: string
}

export interface GenerateElementResult {
  ok: boolean
  path?: string
  error?: string
}

export async function generateElement(
  payload: GenerateElementPayload
): Promise<GenerateElementResult> {
  const key = loadSettings().openaiApiKey
  if (!key) {
    return { ok: false, error: 'Configure a API key da OpenAI em ⚙ Ajustes para gerar elementos.' }
  }

  // Steer the model towards a clean cut-out asset rather than an illustration
  // with a painted background — the user asked for an element, not a picture.
  const prompt =
    `${payload.prompt.trim()}. Isolated single object, centered, no background, ` +
    'no scenery, no text watermark, clean edges, sticker/icon style suitable for ' +
    'overlaying on video.'

  try {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt,
        size: payload.size ?? '1024x1024',
        background: 'transparent',
        output_format: 'png',
        n: 1
      })
    })
    if (!res.ok) {
      const body = await res.text()
      return { ok: false, error: `OpenAI ${res.status}: ${body.slice(0, 300)}` }
    }
    const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> }
    const item = json.data?.[0]
    let bytes: Buffer
    if (item?.b64_json) {
      bytes = Buffer.from(item.b64_json, 'base64')
    } else if (item?.url) {
      const img = await fetch(item.url)
      bytes = Buffer.from(await img.arrayBuffer())
    } else {
      return { ok: false, error: 'A OpenAI não devolveu imagem.' }
    }

    if (!existsSync(payload.outDir)) mkdirSync(payload.outDir, { recursive: true })
    const slug =
      payload.prompt
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'elemento'
    const out = join(payload.outDir, `${slug}-${Date.now()}.png`)
    writeFileSync(out, bytes)
    return { ok: true, path: out }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
