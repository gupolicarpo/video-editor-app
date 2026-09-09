export const SEEDREAM_CHARACTER_MODEL = 'seedream-5-0-lite-260128'

const DEFAULT_CHARACTER_PROMPT =
  'Recreate Image 1 as the same fictional character. Preserve exactly the identity, face, hairstyle, body proportions, clothing, colors and character design. Clean neutral background, single character, no text.'

export function buildSeedreamCharacterRequest(
  imageUrl: string,
  prompt = DEFAULT_CHARACTER_PROMPT
): Record<string, unknown> {
  return {
    model: SEEDREAM_CHARACTER_MODEL,
    prompt: prompt.trim() || DEFAULT_CHARACTER_PROMPT,
    image: imageUrl,
    size: '2K',
    output_format: 'png',
    response_format: 'url',
    watermark: false
  }
}

export function seedreamOutputUrl(response: unknown): string {
  const url = (response as { data?: Array<{ url?: unknown }> })?.data?.[0]?.url
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
    throw new Error('Seedream concluiu sem retornar a URL original da imagem.')
  }
  return url
}
