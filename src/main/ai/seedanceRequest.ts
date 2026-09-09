export type SeedanceImageRole = 'reference_image' | 'first_frame' | 'last_frame'

export interface SeedanceImageReference {
  url: string
  role: SeedanceImageRole
}

export interface SeedanceRequestInput {
  model: string
  prompt: string
  images?: SeedanceImageReference[]
  videos?: string[]
  audios?: string[]
  resolution?: string
  ratio?: string
  duration?: number
  generateAudio: boolean
  watermark?: boolean
  returnLastFrame?: boolean
  priority?: number
}

const RATIOS = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'])
const STANDARD_RESOLUTIONS = new Set(['480p', '720p', '1080p', '4k'])
const COMPACT_RESOLUTIONS = new Set(['480p', '720p'])

export function seedanceResolutions(model: string): string[] {
  const compact = /(?:fast|mini)/i.test(model)
  return [...(compact ? COMPACT_RESOLUTIONS : STANDARD_RESOLUTIONS)]
}

export function isSeedanceVideoUrl(value: string): boolean {
  return /^(?:https?:\/\/|asset:\/\/)/i.test(value)
}

export function seedancePromptForMode(mode: string | undefined, prompt: string): string {
  const text = prompt.trim()
  if (!text) return ''
  if (mode === 'motion') return `Use o Vídeo 1 como referência de movimento e câmera. ${text}`
  if (mode === 'extend') return `Continue o Vídeo 1 de forma natural. ${text}`
  if (mode === 'connect') return `Conecte o Vídeo 1 ao Vídeo 2 de forma contínua. ${text}`
  if (mode === 'edit') return `Edite o Vídeo 1 preservando o que não foi pedido para mudar. ${text}`
  return text
}

export function buildSeedanceRequest(input: SeedanceRequestInput): Record<string, unknown> {
  const prompt = input.prompt.trim()
  if (!prompt) throw new Error('Escreva um prompt para a Seedance.')

  const images = input.images || []
  const videos = input.videos || []
  const audios = input.audios || []

  if (images.length > 9) throw new Error('A Seedance aceita no máximo 9 imagens de referência.')
  if (videos.length > 3) throw new Error('A Seedance aceita no máximo 3 vídeos de referência.')
  if (audios.length > 3) throw new Error('A Seedance aceita no máximo 3 áudios de referência.')
  if (audios.length > 0 && images.length === 0 && videos.length === 0) {
    throw new Error('Áudio de referência precisa ser usado junto com uma imagem ou um vídeo.')
  }

  const frameImages = images.filter((image) => image.role === 'first_frame' || image.role === 'last_frame')
  const referenceImages = images.filter((image) => image.role === 'reference_image')
  if (frameImages.length > 0 && (referenceImages.length > 0 || videos.length > 0 || audios.length > 0)) {
    throw new Error('Quadro inicial/final não pode ser misturado com referências multimodais.')
  }
  if (images.filter((image) => image.role === 'first_frame').length > 1) {
    throw new Error('Escolha apenas um quadro inicial.')
  }
  if (images.filter((image) => image.role === 'last_frame').length > 1) {
    throw new Error('Escolha apenas um quadro final.')
  }
  for (const video of videos) {
    if (!isSeedanceVideoUrl(video)) {
      throw new Error('Vídeos de referência precisam de uma URL http/https temporária ou asset://.')
    }
  }

  if (input.resolution && !seedanceResolutions(input.model).includes(input.resolution)) {
    throw new Error(`O modelo selecionado não aceita resolução ${input.resolution}.`)
  }
  if (input.ratio && !RATIOS.has(input.ratio)) {
    throw new Error(`Proporção ${input.ratio} não é aceita pela Seedance 2.0.`)
  }
  if (input.duration !== undefined && input.duration !== -1) {
    if (!Number.isInteger(input.duration) || input.duration < 4 || input.duration > 15) {
      throw new Error('A duração deve ser Automática ou um número inteiro de 4 a 15 segundos.')
    }
  }
  if (
    input.priority !== undefined &&
    (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 9)
  ) {
    throw new Error('A prioridade deve ser um número inteiro de 0 a 9.')
  }
  if (input.priority !== undefined && /(?:fast|mini)/i.test(input.model)) {
    throw new Error('Prioridade só está disponível no modelo Standard.')
  }

  const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }]
  for (const image of images) {
    content.push({ type: 'image_url', role: image.role, image_url: { url: image.url } })
  }
  for (const video of videos) {
    content.push({ type: 'video_url', role: 'reference_video', video_url: { url: video } })
  }
  for (const audio of audios) {
    content.push({ type: 'audio_url', role: 'reference_audio', audio_url: { url: audio } })
  }

  const body: Record<string, unknown> = {
    model: input.model,
    content,
    generate_audio: input.generateAudio,
    watermark: input.watermark ?? false
  }
  if (input.resolution) body.resolution = input.resolution
  if (input.ratio) body.ratio = input.ratio
  if (input.duration !== undefined) body.duration = input.duration
  if (input.returnLastFrame !== undefined) body.return_last_frame = input.returnLastFrame
  if (input.priority !== undefined) body.priority = input.priority
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 64 * 1024 * 1024) {
    throw new Error('As referências ultrapassam o limite de 64 MB da requisição Seedance.')
  }
  return body
}
