// Unified AI provider registry (inspired by OpenMontage's tool layer, reimplemented).
// Each provider declares what it does, how good/reliable it is, its rough cost,
// and how our app can reach it. The scoring module ranks these per task.

export type Capability =
  | 'text2video'
  | 'image2video'
  | 'video2video'
  | 'lipsync'
  | 'tts'
  | 'image'
  | 'bgremove'
  | 'upscale'

// How our app reaches the provider.
//  - 'api'  : direct API call from the app (we have or can build the integration)
//  - 'mcp'  : through a connected MCP (Claude triggers it, e.g. Kling)
//  - 'local': runs on this machine (free, may need a GPU / setup)
//  - 'site' : the user runs it on the provider's website, then imports the file
export type Runtime = 'api' | 'mcp' | 'local' | 'site'

export interface CostInputs {
  seconds?: number
  chars?: number
  images?: number
}

export interface Provider {
  id: string
  name: string
  capabilities: Capability[]
  bestFor: string[]
  supports: Record<string, boolean>
  quality: number // 0..1 expected fidelity
  reliability: number // 0..1 runtime confidence
  latencyP50: number // seconds (lower is better)
  runtime: Runtime
  allowsRealFace: boolean // can it animate/edit the user's real face?
  callableNow: boolean // can the app trigger it directly today?
  estimateCost: (inp: CostInputs) => number // USD (0 for free/local/credits)
  note?: string
}

const perSecond =
  (usd: number) =>
  ({ seconds = 5 }: CostInputs): number =>
    +(usd * seconds).toFixed(3)
const perChar =
  (usd: number) =>
  ({ chars = 300 }: CostInputs): number =>
    +(usd * chars).toFixed(3)
const perImage =
  (usd: number) =>
  ({ images = 1 }: CostInputs): number =>
    +(usd * images).toFixed(3)
const free = (): number => 0

export const PROVIDERS: Provider[] = [
  // ---- Video generation / editing ----
  {
    id: 'seedance_runway',
    name: 'Seedance 2.0 (via Runway)',
    capabilities: ['text2video', 'image2video', 'video2video'],
    bestFor: ['cinematic clips', 'native audio', 'lip-sync', 'real footage editing', 'camera control'],
    supports: { native_audio: true, lip_sync: true, reference_image: true, video_to_video: true },
    quality: 0.95,
    reliability: 0.9,
    latencyP50: 120,
    runtime: 'site',
    allowsRealFace: true,
    callableNow: false,
    estimateCost: perSecond(0.25),
    note: 'Melhor qualidade + aceita seu rosto. Hoje você roda no site da Runway e importa o MP4.'
  },
  {
    id: 'kling',
    name: 'Kling (MCP conectado)',
    capabilities: ['text2video', 'image2video', 'image'],
    bestFor: ['image animation', 'subject + scene composition', 'stylized motion'],
    supports: { image_to_video: true, subject_scene: true, native_audio: true },
    quality: 0.85,
    reliability: 0.85,
    latencyP50: 150,
    runtime: 'mcp',
    allowsRealFace: true,
    callableNow: false,
    estimateCost: free,
    note: 'Já conectado via MCP (créditos online grátis). Sem vídeo-pra-vídeo. O Claude dispara.'
  },
  {
    id: 'luma',
    name: 'Luma Ray 3.2 (Modify)',
    capabilities: ['video2video', 'image'],
    bestFor: ['relight', 'restyle', 'background change keeping motion'],
    supports: { video_to_video: true, first_frame: true, modes: true },
    quality: 0.8,
    reliability: 0.85,
    latencyP50: 180,
    runtime: 'api',
    allowsRealFace: false,
    callableNow: true,
    estimateCost: perSecond(0.3),
    note: 'Integrado no app (botão Luma). Sem trava de identidade — reinventa o rosto.'
  },
  {
    id: 'veo',
    name: 'Google Veo 3.1',
    capabilities: ['text2video', 'image2video'],
    bestFor: ['photoreal', 'native audio', 'reference-to-video'],
    supports: { native_audio: true, reference_image: true },
    quality: 0.92,
    reliability: 0.88,
    latencyP50: 150,
    runtime: 'api',
    allowsRealFace: true,
    callableNow: false,
    estimateCost: perSecond(0.4),
    note: 'Alta qualidade. Precisa de chave do Google e integração (a construir).'
  },
  {
    id: 'seedance_byteplus',
    name: 'Seedance (API ByteDance)',
    capabilities: ['text2video', 'image2video'],
    bestFor: ['cinematic clips', 'native audio'],
    supports: { native_audio: true },
    quality: 0.95,
    reliability: 0.6,
    latencyP50: 120,
    runtime: 'api',
    allowsRealFace: false,
    callableNow: true,
    estimateCost: perSecond(0.25),
    note: '⚠️ Bloqueia rosto real (moderação ByteDance). Bom só pra cenas sem pessoas.'
  },
  {
    id: 'wan_local',
    name: 'WAN 2.1 (local, grátis)',
    capabilities: ['text2video', 'image2video'],
    bestFor: ['free generation', 'no restrictions', 'full control'],
    supports: { image_to_video: true, no_moderation: true },
    quality: 0.6,
    reliability: 0.7,
    latencyP50: 400,
    runtime: 'local',
    allowsRealFace: true,
    callableNow: false,
    estimateCost: free,
    note: 'Grátis e sem restrições, mas sua GPU (8GB) limita a ~480p e é lento. Precisa setup.'
  },
  // ---- Image generation / reference upgrade ----
  {
    id: 'gpt_image_2',
    name: 'OpenAI gpt-image-2 (Image 2.0)',
    capabilities: ['image'],
    bestFor: [
      'high quality images',
      'reference image edit and upgrade',
      'remake original frames faithfully',
      'photoreal',
      'cinematic'
    ],
    supports: { reference_image: true, image_edit: true, high_quality: true },
    quality: 0.93,
    reliability: 0.9,
    latencyP50: 30,
    runtime: 'api',
    allowsRealFace: false,
    callableNow: true,
    estimateCost: perImage(0.21),
    note: 'Qualidade alta + aceita imagem de referência (usada no Remake com referência). ~$0,21/imagem (high). Precisa de chave OpenAI.'
  },
  // ---- Avatar / lip-sync ----
  {
    id: 'heygen',
    name: 'HeyGen (avatar / lip-sync)',
    capabilities: ['lipsync'],
    bestFor: ['talking head', 'scripted narration', 'lip-sync to your voice', 'real face'],
    supports: { lip_sync: true, real_face: true, scripted: true },
    quality: 0.9,
    reliability: 0.9,
    latencyP50: 180,
    runtime: 'api',
    allowsRealFace: true,
    callableNow: false,
    estimateCost: perSecond(0.1),
    note: 'A peça pra "você falando" com lip-sync. Precisa de chave HeyGen + integração (a construir).'
  },
  // ---- TTS ----
  {
    id: 'elevenlabs',
    name: 'ElevenLabs (voz)',
    capabilities: ['tts'],
    bestFor: ['natural voice', 'voice cloning', 'multilingual'],
    supports: { cloning: true, multilingual: true },
    quality: 0.95,
    reliability: 0.92,
    latencyP50: 5,
    runtime: 'api',
    allowsRealFace: false,
    callableNow: false,
    estimateCost: perChar(0.0003),
    note: 'Voz mais natural. Precisa de chave + integração.'
  },
  {
    id: 'piper',
    name: 'Piper (voz offline grátis)',
    capabilities: ['tts'],
    bestFor: ['offline narration', 'free', 'fast'],
    supports: { offline: true, free: true },
    quality: 0.65,
    reliability: 0.95,
    latencyP50: 2,
    runtime: 'local',
    allowsRealFace: false,
    callableNow: false,
    estimateCost: free,
    note: 'Narração offline grátis. Precisa instalar o binário Piper.'
  },
  // ---- Post / utilities (free, local) ----
  {
    id: 'rembg',
    name: 'Recorte de fundo (local grátis)',
    capabilities: ['bgremove'],
    bestFor: ['background removal', 'matting', 'free'],
    supports: { free: true, offline: true },
    quality: 0.75,
    reliability: 0.9,
    latencyP50: 60,
    runtime: 'local',
    allowsRealFace: true,
    callableNow: true,
    estimateCost: free,
    note: 'Já temos (rembg). Recorta a pessoa e troca o fundo, grátis.'
  }
]

export const CAPABILITY_LABEL: Record<Capability, string> = {
  text2video: 'Texto → vídeo',
  image2video: 'Imagem → vídeo (animar)',
  video2video: 'Vídeo → vídeo (editar/relight)',
  lipsync: 'Lip-sync / avatar falando',
  tts: 'Narração (voz)',
  image: 'Gerar imagem',
  bgremove: 'Remover/trocar fundo',
  upscale: 'Aumentar qualidade'
}
