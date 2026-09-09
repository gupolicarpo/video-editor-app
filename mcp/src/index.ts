#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { probeMedia, prepareMedia, enhanceClip, enhanceAudio, applyLook } from '../../src/main/ffmpeg'
import {
  loadProject,
  saveProject,
  baseClip,
  DEFAULT_TEXT,
  durationOf,
  genId,
  audioCacheDir,
  type ProjectData,
  type Clip
} from './project'
import { renderProject } from './render'
import { generateSeedance } from './seedance'
import { renderHyperframesFx } from './hyperframes'

const server = new McpServer({ name: 'video-editor', version: '0.2.0' })

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })

function summary(p: ProjectData): string {
  const lines: string[] = []
  lines.push(`Projeto ${p.projectW}x${p.projectH} @ ${p.projectFps}fps · duração ${durationOf(p).toFixed(2)}s`)
  lines.push(`Faixas (de cima p/ baixo): ${p.tracks.map((t) => `${t.name}[${t.id}]`).join(', ')}`)
  lines.push(`Mídia: ${p.media.length ? p.media.map((m) => `${m.name}[${m.id}] ${m.type} ${m.duration.toFixed(1)}s`).join('; ') : '(nenhuma)'}`)
  if (p.clips.length === 0) lines.push('Clipes: (nenhum)')
  else {
    lines.push('Clipes:')
    for (const c of [...p.clips].sort((a, b) => a.start - b.start)) {
      const label = c.type === 'text' ? `texto "${c.text?.content?.slice(0, 20)}"` : p.media.find((m) => m.id === c.mediaId)?.name || c.type
      const extra = [
        c.transition ? `transição:${c.transition.type}` : '',
        c.scale !== 1 ? `escala:${Math.round(c.scale * 100)}%` : '',
        c.opacity !== 1 ? `opac:${Math.round(c.opacity * 100)}%` : ''
      ].filter(Boolean).join(' ')
      lines.push(`  [${c.id}] ${label} faixa:${c.trackId} ${c.start.toFixed(2)}→${(c.start + c.duration).toFixed(2)}s ${extra}`)
    }
  }
  return lines.join('\n')
}

function pickTrack(p: ProjectData, kind: 'video' | 'audio', trackId?: string): string | null {
  if (trackId) return p.tracks.find((t) => t.id === trackId)?.id ?? null
  return p.tracks.find((t) => t.kind === kind)?.id ?? null
}

// ---- read ----
server.registerTool(
  'get_project',
  {
    title: 'Ver projeto',
    description: 'Retorna o estado atual da timeline: dimensões, faixas, mídia e clipes (com ids para editar).',
    inputSchema: {},
    annotations: { readOnlyHint: true }
  },
  async () => ok(summary(loadProject()))
)

server.registerTool(
  'set_project_settings',
  {
    title: 'Configurar projeto',
    description: 'Define resolução e fps do projeto.',
    inputSchema: { width: z.number().int().optional(), height: z.number().int().optional(), fps: z.number().int().optional() }
  },
  async ({ width, height, fps }) => {
    const p = loadProject()
    if (width) p.projectW = width
    if (height) p.projectH = height
    if (fps) p.projectFps = fps
    saveProject(p)
    return ok(`Projeto: ${p.projectW}x${p.projectH} @ ${p.projectFps}fps`)
  }
)

// ---- media ----
server.registerTool(
  'import_media',
  {
    title: 'Importar mídia',
    description: 'Importa um arquivo local (vídeo/áudio/imagem) para a biblioteca. Retorna o id e os metadados.',
    inputSchema: { filePath: z.string().describe('Caminho absoluto do arquivo no disco.') }
  },
  async ({ filePath }) => {
    try {
      const meta = await prepareMedia(filePath, audioCacheDir())
      const p = loadProject()
      const id = genId()
      p.media.push({
        id,
        name: filePath.split(/[\\/]/).pop() || filePath,
        path: filePath,
        audioPath: meta.audioPath,
        audioPaths: meta.audioPaths,
        type: meta.type,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        hasAudio: meta.hasAudio,
        hasVideo: meta.hasVideo,
        fps: meta.fps
      })
      saveProject(p)
      return ok(`Importado [${id}] ${meta.type} ${meta.width}x${meta.height} ${meta.duration.toFixed(2)}s`)
    } catch (e: any) {
      return fail(`Falha ao importar: ${e?.message || e}`)
    }
  }
)

server.registerTool(
  'add_track',
  {
    title: 'Adicionar faixa',
    description: 'Adiciona uma faixa de vídeo (no topo) ou áudio (embaixo).',
    inputSchema: { kind: z.enum(['video', 'audio']) }
  },
  async ({ kind }) => {
    const p = loadProject()
    const count = p.tracks.filter((t) => t.kind === kind).length + 1
    const track = { id: genId(), kind, name: `${kind === 'video' ? 'Vídeo' : 'Áudio'} ${count}` }
    if (kind === 'video') p.tracks.unshift(track)
    else p.tracks.push(track)
    saveProject(p)
    return ok(`Faixa criada [${track.id}] ${track.name}`)
  }
)

// ---- clips ----
server.registerTool(
  'add_clip',
  {
    title: 'Adicionar clipe',
    description:
      'Coloca um clipe de mídia na timeline. Se trackId for omitido, usa a primeira faixa do tipo certo. start em segundos.',
    inputSchema: {
      mediaId: z.string(),
      trackId: z.string().optional(),
      start: z.number().default(0),
      inPoint: z.number().optional(),
      duration: z.number().optional(),
      scale: z.number().optional(),
      xFrac: z.number().optional(),
      yFrac: z.number().optional(),
      rotate: z.number().optional(), // giro fixo em graus (0..360)
      opacity: z.number().optional(),
      fit: z.enum(['contain', 'cover', 'fill']).optional()
    }
  },
  async (a) => {
    const p = loadProject()
    const m = p.media.find((x) => x.id === a.mediaId)
    if (!m) return fail(`Mídia ${a.mediaId} não encontrada.`)
    const trackId = pickTrack(p, m.type === 'audio' ? 'audio' : 'video', a.trackId)
    if (!trackId) return fail('Nenhuma faixa compatível.')
    const clip = baseClip({
      mediaId: m.id,
      trackId,
      type: m.type,
      start: Math.max(0, a.start),
      duration: a.duration ?? (m.duration || (m.type === 'image' ? 5 : 3)),
      inPoint: a.inPoint ?? 0,
      scale: a.scale ?? 1,
      xFrac: a.xFrac ?? 0,
      yFrac: a.yFrac ?? 0,
      rotate: a.rotate ?? 0,
      opacity: a.opacity ?? 1,
      fit: a.fit ?? (m.type === 'image' ? 'cover' : 'contain')
    })
    p.clips.push(clip)
    saveProject(p)
    return ok(`Clipe adicionado [${clip.id}] em ${clip.start.toFixed(2)}s na faixa ${trackId}`)
  }
)

server.registerTool(
  'add_text',
  {
    title: 'Adicionar texto',
    description: 'Adiciona um texto/legenda sobre o vídeo. Posição por xFrac/yFrac (0 = centro, -0.5..0.5).',
    inputSchema: {
      content: z.string(),
      start: z.number().default(0),
      duration: z.number().default(4),
      fontSizeRel: z.number().optional().describe('Fração da altura (0.09 ≈ título).'),
      color: z.string().optional(),
      bold: z.boolean().optional(),
      align: z.enum(['left', 'center', 'right']).optional(),
      xFrac: z.number().optional(),
      yFrac: z.number().optional(),
      rotate: z.number().optional(), // giro fixo em graus (0..360)
      bgColor: z.string().nullable().optional(),
      outline: z.boolean().optional(),
      trackId: z.string().optional()
    }
  },
  async (a) => {
    const p = loadProject()
    const trackId = pickTrack(p, 'video', a.trackId)
    if (!trackId) return fail('Nenhuma faixa de vídeo.')
    const clip = baseClip({
      type: 'text',
      trackId,
      start: Math.max(0, a.start),
      duration: a.duration,
      yFrac: a.yFrac ?? 0.32,
      xFrac: a.xFrac ?? 0,
      rotate: a.rotate ?? 0,
      text: {
        ...DEFAULT_TEXT,
        content: a.content,
        fontSizeRel: a.fontSizeRel ?? DEFAULT_TEXT.fontSizeRel,
        color: a.color ?? DEFAULT_TEXT.color,
        bold: a.bold ?? DEFAULT_TEXT.bold,
        align: a.align ?? DEFAULT_TEXT.align,
        bgColor: a.bgColor ?? null,
        outline: a.outline ?? DEFAULT_TEXT.outline
      }
    })
    p.clips.push(clip)
    saveProject(p)
    return ok(`Texto adicionado [${clip.id}]: "${a.content}"`)
  }
)

server.registerTool(
  'update_clip',
  {
    title: 'Editar clipe',
    description: 'Altera propriedades de um clipe existente (posição, tamanho, cor, fade, velocidade, volume, etc.).',
    inputSchema: {
      clipId: z.string(),
      mediaId: z.string().optional().describe('Trocar a mídia que o clipe usa (ex: versão melhorada).'),
      start: z.number().optional(),
      duration: z.number().optional(),
      inPoint: z.number().optional(),
      scale: z.number().optional(),
      xFrac: z.number().optional(),
      yFrac: z.number().optional(),
      rotate: z.number().optional(), // giro fixo em graus (0..360)
      opacity: z.number().optional(),
      fit: z.enum(['contain', 'cover', 'fill']).optional(),
      volume: z.number().optional(),
      fadeIn: z.number().optional(),
      fadeOut: z.number().optional(),
      speed: z.number().optional(),
      brightness: z.number().optional(),
      contrast: z.number().optional(),
      saturation: z.number().optional(),
      trackId: z.string().optional()
    }
  },
  async (a) => {
    const p = loadProject()
    const c = p.clips.find((x) => x.id === a.clipId)
    if (!c) return fail(`Clipe ${a.clipId} não encontrado.`)
    const { clipId, ...patch } = a
    Object.assign(c, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)))
    saveProject(p)
    return ok(`Clipe ${a.clipId} atualizado.`)
  }
)

server.registerTool(
  'set_transition',
  {
    title: 'Definir transição',
    description:
      'Aplica uma transição na entrada do clipe (mistura com o clipe anterior na mesma faixa). type "none" remove.',
    inputSchema: {
      clipId: z.string(),
      type: z.enum(['none', 'fade', 'dissolve', 'slideleft', 'slideright', 'slideup', 'slidedown', 'wipeleft', 'wiperight', 'zoom', 'circle']),
      duration: z.number().default(0.7)
    }
  },
  async ({ clipId, type, duration }) => {
    const p = loadProject()
    const c = p.clips.find((x) => x.id === clipId)
    if (!c) return fail(`Clipe ${clipId} não encontrado.`)
    if (type === 'none') {
      delete c.transition
      saveProject(p)
      return ok(`Transição removida de ${clipId}.`)
    }
    const prev = p.clips
      .filter((x) => x.id !== clipId && x.trackId === c.trackId && x.start < c.start)
      .sort((a, b) => b.start + b.duration - (a.start + a.duration))[0]
    if (prev) {
      const prevEnd = prev.start + prev.duration
      if (c.start <= prevEnd + 0.1) c.start = Math.max(prev.start + 0.1, prevEnd - duration)
    }
    c.transition = { type, duration }
    saveProject(p)
    return ok(`Transição "${type}" (${duration}s) aplicada em ${clipId}.`)
  }
)

server.registerTool(
  'remove_clip',
  {
    title: 'Remover clipe',
    description: 'Remove um clipe da timeline.',
    inputSchema: { clipId: z.string() },
    annotations: { destructiveHint: true }
  },
  async ({ clipId }) => {
    const p = loadProject()
    const before = p.clips.length
    p.clips = p.clips.filter((c) => c.id !== clipId)
    saveProject(p)
    return ok(before === p.clips.length ? `Clipe ${clipId} não encontrado.` : `Clipe ${clipId} removido.`)
  }
)

// ---- enhance ----
server.registerTool(
  'enhance_clip',
  {
    title: 'Melhorar imagem do clipe',
    description:
      'Aplica tratamento de qualidade (redução de ruído, cor, nitidez, upscale opcional) num clipe de vídeo e substitui o clipe pelo resultado. Preserva transparência (alfa).',
    inputSchema: {
      clipId: z.string(),
      strength: z.enum(['leve', 'medio', 'forte']).default('medio'),
      upscale: z.boolean().default(true),
      warm: z.boolean().default(true)
    }
  },
  async ({ clipId, strength, upscale, warm }) => {
    const p = loadProject()
    const c = p.clips.find((x) => x.id === clipId)
    if (!c || c.type !== 'video') return fail('Selecione um clipe de vídeo válido.')
    const m = p.media.find((x) => x.id === c.mediaId)
    if (!m) return fail('Mídia do clipe não encontrada.')
    try {
      const { mediaOutputDir } = await import('./project')
      const out = await enhanceClip(m.path, c.inPoint, c.duration, { strength, upscale, warm }, `${mediaOutputDir()}/enhanced-${genId()}.mp4`)
      const meta = await probeMedia(out)
      const id = genId()
      p.media.push({ id, name: out.split(/[\\/]/).pop()!, path: out, type: meta.type, duration: meta.duration, width: meta.width, height: meta.height, hasAudio: meta.hasAudio, hasVideo: meta.hasVideo, fps: meta.fps })
      c.mediaId = id
      c.inPoint = 0
      c.duration = meta.duration
      saveProject(p)
      return ok(`Clipe ${clipId} melhorado (${strength}${upscale ? ', upscale 1080p' : ''}).`)
    } catch (e: any) {
      return fail(`Falha no enhance: ${e?.message || e}`)
    }
  }
)

// ---- effects & element animations ----
const CAMERA_MOTIONS = new Set([
  'zoompunch', 'kenburns', 'snapzoom', 'breathe', 'panright', 'panleft', 'panup', 'pandown', 'tilt', 'shake'
])

server.registerTool(
  'add_effect',
  {
    title: 'Adicionar efeito de movimento',
    description:
      'Aplica um efeito de movimento/foco ao clipe (zoom punch, Ken Burns, pan, tilt, shake, vinheta, blur, P&B). Efeitos de câmera são exclusivos: adicionar um troca o anterior. type "none" remove todos.',
    inputSchema: {
      clipId: z.string(),
      type: z.enum(['none', 'zoompunch', 'kenburns', 'snapzoom', 'breathe', 'panright', 'panleft', 'panup', 'pandown', 'tilt', 'shake', 'vignette', 'blur', 'bw']),
      at: z.number().optional().describe('Início dentro do clipe (s). Padrão 0.'),
      duration: z.number().optional().describe('Duração do efeito (s). Padrão: clipe inteiro.'),
      amount: z.number().optional().describe('Intensidade (zoom 0.1-0.3, pan px, shake px, blur sigma).')
    }
  },
  async ({ clipId, type, at, duration, amount }) => {
    const p = loadProject()
    const c = p.clips.find((x) => x.id === clipId)
    if (!c) return fail('Clipe não encontrado.')
    if (type === 'none') {
      c.effects = undefined
      saveProject(p)
      return ok(`Efeitos removidos de ${clipId}.`)
    }
    const defAmount =
      type === 'shake' ? 8 : type === 'tilt' ? 5 : type === 'blur' ? 6 : type === 'vignette' ? 0.4 : type === 'bw' ? 1 : type.startsWith('pan') ? 60 : 0.15
    const eff = {
      type,
      at: at ?? 0,
      duration: duration ?? Math.max(1, c.duration),
      amount: amount ?? defAmount
    }
    const kept = (c.effects || []).filter((e) => (CAMERA_MOTIONS.has(type) ? !CAMERA_MOTIONS.has(e.type) : e.type !== type))
    c.effects = [...kept, eff as NonNullable<Clip['effects']>[number]]
    saveProject(p)
    return ok(`Efeito ${type} aplicado a ${clipId} (${eff.at}s→${(eff.at + eff.duration).toFixed(1)}s, intensidade ${eff.amount}).`)
  }
)

server.registerTool(
  'set_anim',
  {
    title: 'Animação do elemento',
    description:
      'Define as animações de entrada/loop/saída de um clipe (imagem, vídeo ou texto). Elas tocam no preview e são assadas no export. "none" limpa cada campo.',
    inputSchema: {
      clipId: z.string(),
      in: z
        .enum([
          'none', 'fade', 'popup', 'slideL', 'slideR', 'slideU', 'slideD', 'wipe', 'zoom', 'rotate',
          'flip', 'flip3d', 'spin3d', 'grow', 'bounce', 'jump', 'fall', 'drift', 'dash', 'breath',
          'heartbeat', 'scrapbook', 'tumble', 'stomp'
        ])
        .optional()
        .describe('"grow" cresce ao longo do eixo de inDir ancorando a borda oposta (inDir "up" = barra sobe com o pé fixo). "wipe" revela por máscara (nada se move).'),
      inDur: z.number().optional(),
      inDir: z.enum(['center', 'right', 'left', 'down', 'up', 'upright', 'upleft', 'downright', 'downleft']).optional(),
      loop: z
        .enum([
          'none', 'pulse', 'shake', 'sway', 'sway3d', 'wiggle', 'jiggle', 'float', 'jump',
          'heartbeat', 'neon', 'spin', 'spin3d', 'flip', 'credits', 'creditsOnce', 'balloon'
        ])
        .optional(),
      loopSpeed: z
        .number()
        .min(0.1)
        .max(4)
        .optional()
        .describe('Ritmo do loop: 1 = padrão, 2 = o dobro de rápido, 0.5 = metade. Spin: uma volta a cada 3/loopSpeed segundos.'),
      out: z
        .enum([
          'none', 'fade', 'popout', 'slideL', 'slideR', 'slideU', 'slideD', 'wipe', 'zoom', 'rotate',
          'flip', 'flip3d', 'spin3d', 'bounce', 'jump', 'drift', 'dash', 'breath', 'heartbeat',
          'scrapbook', 'tumble', 'stomp'
        ])
        .optional(),
      outDur: z.number().optional(),
      outDir: z.enum(['center', 'right', 'left', 'down', 'up', 'upright', 'upleft', 'downright', 'downleft']).optional()
    }
  },
  async (a) => {
    const p = loadProject()
    const c = p.clips.find((x) => x.id === a.clipId)
    if (!c) return fail('Clipe não encontrado.')
    c.anim = {
      ...(c.anim || {}),
      ...(a.in !== undefined ? { in: a.in } : {}),
      ...(a.inDur !== undefined ? { inDur: a.inDur } : {}),
      ...(a.inDir !== undefined ? { inDir: a.inDir } : {}),
      ...(a.loop !== undefined ? { loop: a.loop } : {}),
      ...(a.loopSpeed !== undefined ? { loopSpeed: a.loopSpeed } : {}),
      ...(a.out !== undefined ? { out: a.out } : {}),
      ...(a.outDur !== undefined ? { outDur: a.outDur } : {}),
      ...(a.outDir !== undefined ? { outDir: a.outDir } : {})
    }
    saveProject(p)
    const an = c.anim
    const sp = an.loopSpeed && an.loopSpeed !== 1 ? `@${an.loopSpeed}×` : ''
    return ok(
      `Animação de ${a.clipId}: entrada=${an.in || 'none'}${an.inDir ? `(${an.inDir})` : ''} loop=${an.loop || 'none'}${sp} saída=${an.out || 'none'}${an.outDir ? `(${an.outDir})` : ''}`
    )
  }
)

// ---- audio & look ----
server.registerTool(
  'enhance_audio',
  {
    title: 'Melhorar áudio do clipe',
    description:
      'Trata um clipe de áudio/vídeo com redução de ruído, normalização, EQ de voz, compressor, ganho, reverb e delay. Substitui o clipe pelo resultado (.m4a).',
    inputSchema: {
      clipId: z.string(),
      denoise: z.boolean().default(true),
      denoiseAmount: z.number().min(0).max(1).default(0.25),
      normalize: z.boolean().default(false),
      voice: z.boolean().default(false),
      compressor: z.boolean().default(false),
      gainDb: z.number().min(-24).max(24).default(0),
      reverb: z.number().min(0).max(1).default(0),
      delayMs: z.number().min(20).max(2000).default(250),
      delayMix: z.number().min(0).max(1).default(0),
      channels: z.enum(['original', 'mono', 'stereo']).default('original')
    }
  },
  async ({ clipId, denoise, denoiseAmount, normalize, voice, compressor, gainDb, reverb, delayMs, delayMix, channels }) => {
    const p = loadProject()
    const c = p.clips.find((x) => x.id === clipId)
    if (!c || (c.type !== 'audio' && c.type !== 'video')) return fail('Selecione um clipe de áudio ou vídeo.')
    const m = p.media.find((x) => x.id === c.mediaId)
    if (!m || !m.hasAudio) return fail('A mídia do clipe não tem áudio.')
    try {
      const { mediaOutputDir } = await import('./project')
      const out = await enhanceAudio(
        c.audioSourcePath || m.audioPath || m.path,
        c.inPoint,
        c.duration,
        { denoise, denoiseAmount, normalize, voice, compressor, gainDb, reverb, delayMs, delayMix, channels },
        `${mediaOutputDir()}/audio-${genId()}.m4a`
      )
      const meta = await probeMedia(out)
      const id = genId()
      p.media.push({ id, name: out.split(/[\\/]/).pop()!, path: out, type: 'audio', duration: meta.duration, width: 0, height: 0, hasAudio: true, hasVideo: false, fps: meta.fps })
      c.mediaId = id
      c.type = 'audio'
      c.inPoint = 0
      c.duration = meta.duration
      saveProject(p)
      return ok(
        `Áudio do clipe ${clipId} melhorado (ruído=${denoise ? denoiseAmount : 'off'}, normalizar=${normalize}, compressor=${compressor}, ganho=${gainDb}dB, reverb=${reverb}, delay=${delayMix > 0 ? `${delayMs}ms/${delayMix}` : 'off'}).`
      )
    } catch (e: any) {
      return fail(`Falha no áudio: ${e?.message || e}`)
    }
  }
)

server.registerTool(
  'apply_look',
  {
    title: 'Aplicar look de referência',
    description:
      'Aplica o grade cinematográfico calibrado (pele natural, pretos neutros) ao clipe de vídeo e o substitui pelo resultado.',
    inputSchema: { clipId: z.string() }
  },
  async ({ clipId }) => {
    const p = loadProject()
    const c = p.clips.find((x) => x.id === clipId)
    if (!c || c.type !== 'video') return fail('Selecione um clipe de vídeo válido.')
    const m = p.media.find((x) => x.id === c.mediaId)
    if (!m) return fail('Mídia do clipe não encontrada.')
    try {
      const { mediaOutputDir } = await import('./project')
      const out = await applyLook(m.path, c.inPoint, c.duration, `${mediaOutputDir()}/look-${genId()}.mp4`)
      const meta = await probeMedia(out)
      const id = genId()
      p.media.push({ id, name: out.split(/[\\/]/).pop()!, path: out, type: meta.type, duration: meta.duration, width: meta.width, height: meta.height, hasAudio: meta.hasAudio, hasVideo: meta.hasVideo, fps: meta.fps })
      c.mediaId = id
      c.inPoint = 0
      c.duration = meta.duration
      saveProject(p)
      return ok(`Look de referência aplicado ao clipe ${clipId}.`)
    } catch (e: any) {
      return fail(`Falha no look: ${e?.message || e}`)
    }
  }
)

// ---- AI generation / editing ----
server.registerTool(
  'generate_video',
  {
    title: 'Gerar/editar vídeo com IA (Seedance)',
    description:
      'Usa Seedance 2.0 para gerar, copiar movimento/câmera, editar, estender ou conectar vídeos. Aceita imagens, vídeos e áudios de referência e envia arquivos locais de vídeo por TOS temporário.',
    inputSchema: {
      mode: z.enum(['generate', 'motion', 'edit', 'extend', 'connect']).default('generate'),
      prompt: z.string(),
      model: z
        .enum([
          'dreamina-seedance-2-0-260128',
          'dreamina-seedance-2-0-fast-260128',
          'dreamina-seedance-2-0-mini-260615'
        ])
        .optional(),
      refClipId: z
        .string()
        .optional()
        .describe('Clipe-base local. Opcional quando videoPaths contém uma referência asset:// confiável.'),
      characterImagePaths: z
        .array(z.string())
        .max(4)
        .optional()
        .describe(
          'Personagens proprios: imagens locais ou URLs que o MCP prepara com Seedream 5 Lite antes de enviar a URL original confiavel ao Seedance. Cada imagem gera uma cobranca adicional do Seedream.'
        ),
      imagePaths: z
        .array(z.string())
        .optional()
        .describe('Imagens locais, URLs ou asset:// de referência (novo fundo, elemento, estilo).'),
      imageRefs: z
        .array(
          z.object({
            path: z.string(),
            role: z.enum(['reference_image', 'first_frame', 'last_frame'])
          })
        )
        .optional()
        .describe('Imagens com função explícita; primeiro/último quadro não misturam com referências multimodais.'),
      videoPaths: z
        .array(z.string())
        .max(3)
        .optional()
        .describe(
          'Vídeos locais, URLs http/https ou asset://. Use asset:// para personagens confiáveis da ModelArk; máximo 3 contando o clipe-base.'
        ),
      audioPaths: z.array(z.string()).max(3).optional().describe('Áudios de referência locais, URL ou asset://.'),
      resolution: z.enum(['480p', '720p', '1080p', '4k']).optional(),
      aspectRatio: z.string().optional(),
      durationSec: z
        .number()
        .int()
        .refine((value) => value === -1 || (value >= 4 && value <= 15), '-1 para automático, ou 4 a 15')
        .optional()
        .describe('-1 para duração automática, ou 4 a 15.'),
      generateAudio: z.boolean().optional(),
      watermark: z.boolean().optional(),
      returnLastFrame: z.boolean().optional(),
      priority: z.number().int().min(0).max(9).optional(),
      addToTimeline: z.boolean().default(false),
      replaceClip: z.boolean().default(false)
    }
  },
  async (a) => {
    const p = loadProject()
    const videoReferences: Array<{ path: string; inPoint?: number; duration?: number }> = []
    let refClip: Clip | undefined
    if (a.refClipId) {
      refClip = a.refClipId ? p.clips.find((c) => c.id === a.refClipId) : undefined
      if (!refClip || refClip.type !== 'video') {
        return fail(`refClipId precisa apontar para um clipe de vídeo.`)
      }
      const m = p.media.find((x) => x.id === refClip!.mediaId)
      if (!m) return fail('Mídia do clipe não encontrada.')
      videoReferences.push({
        path: m.path,
        inPoint: refClip.inPoint,
        duration: Math.min(refClip.duration, 15)
      })
    }
    for (const path of a.videoPaths || []) videoReferences.push({ path })
    if (videoReferences.length > 3) return fail('A Seedance aceita no máximo 3 vídeos de referência.')
    if (['motion', 'edit', 'extend'].includes(a.mode) && videoReferences.length < 1) {
      return fail(`Modo ${a.mode} requer refClipId ou uma referência em videoPaths (prefira asset:// para rostos).`)
    }
    if (a.mode === 'connect' && videoReferences.length < 2) {
      return fail('Modo connect requer duas referências entre refClipId e videoPaths.')
    }
    const res = await generateSeedance({
      mode: a.mode,
      prompt: a.prompt,
      model: a.model,
      resolution: a.resolution,
      aspectRatio: a.aspectRatio,
      durationSec: a.durationSec,
      generateAudio: a.generateAudio,
      watermark: a.watermark,
      returnLastFrame: a.returnLastFrame,
      priority: a.priority,
      characterImagePaths: a.characterImagePaths,
      imagePaths: a.imagePaths,
      imageRefs: a.imageRefs,
      videoReferences,
      audioPaths: a.audioPaths
    })
    if (!res.ok || !res.mediaPath) return fail(res.error || 'Falha na geração.')
    const meta = await probeMedia(res.mediaPath)
    const id = genId()
    p.media.push({ id, name: res.mediaPath.split(/[\\/]/).pop()!, path: res.mediaPath, type: meta.type, duration: meta.duration, width: meta.width, height: meta.height, hasAudio: meta.hasAudio, hasVideo: meta.hasVideo, fps: meta.fps })
    let note = `Vídeo gerado [${id}] (${meta.duration.toFixed(1)}s).`
    if (res.preparedCharacterUrls?.length) {
      note += ` ${res.preparedCharacterUrls.length} personagem(ns) proprio(s) preparado(s) via Seedream.`
    }
    if ((a.mode === 'edit' || a.mode === 'extend') && a.replaceClip && refClip) {
      refClip.mediaId = id
      refClip.inPoint = 0
      refClip.duration = meta.duration
      note += ` Clipe ${refClip.id} substituído.`
    } else if (a.addToTimeline) {
      const trackId = pickTrack(p, 'video')!
      const clip = baseClip({ mediaId: id, trackId, type: 'video', start: durationOf(p), duration: meta.duration })
      p.clips.push(clip)
      note += ` Adicionado à timeline [${clip.id}].`
    }
    if (res.lastFramePath) {
      const frameMeta = await probeMedia(res.lastFramePath)
      const frameId = genId()
      p.media.push({
        id: frameId,
        name: res.lastFramePath.split(/[\\/]/).pop()!,
        path: res.lastFramePath,
        type: frameMeta.type,
        duration: frameMeta.duration || 5,
        width: frameMeta.width,
        height: frameMeta.height,
        hasAudio: frameMeta.hasAudio,
        hasVideo: frameMeta.hasVideo,
        fps: frameMeta.fps
      })
      note += ` Último quadro salvo na biblioteca [${frameId}].`
    }
    saveProject(p)
    return ok(note)
  }
)

// ---- HyperFrames FX ----
server.registerTool(
  'generate_fx',
  {
    title: 'Gerar FX com HyperFrames',
    description:
      'Renderiza localmente uma composição HyperFrames escrita pelo Codex e adiciona o resultado à timeline. Use WebM transparente para títulos, lower-thirds, partículas, gráficos e overlays. Chame get_project antes para usar as dimensões e o fps corretos no HTML.',
    inputSchema: {
      html: z.string().min(20).describe('Documento HTML completo da composição HyperFrames.'),
      name: z.string().default('fx-codex'),
      start: z.number().min(0).default(0).describe('Posição do FX na timeline, em segundos.'),
      trackId: z.string().optional().describe('Faixa de vídeo. Se omitida, usa a faixa superior.'),
      transparent: z.boolean().default(true).describe('WebM com alfa quando true; MP4 de tela cheia quando false.')
    }
  },
  async ({ html, name, start, trackId, transparent }) => {
    const p = loadProject()
    const targetTrack = trackId
      ? p.tracks.find((t) => t.id === trackId && t.kind === 'video')
      : p.tracks.find((t) => t.kind === 'video')
    if (!targetTrack) return fail('Nenhuma faixa de vídeo compatível para receber o FX.')

    try {
      const rendered = await renderHyperframesFx({ html, name, transparent, fps: p.projectFps })
      const meta = await probeMedia(rendered.outputPath)
      if (!meta.hasVideo || meta.duration <= 0) return fail('O HyperFrames não produziu um vídeo válido.')

      const mediaId = genId()
      p.media.push({
        id: mediaId,
        name: rendered.outputPath.split(/[\\/]/).pop() || `${name}.${transparent ? 'webm' : 'mp4'}`,
        path: rendered.outputPath,
        type: 'video',
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        hasAudio: meta.hasAudio,
        hasVideo: true,
        fps: meta.fps
      })
      const clip = baseClip({
        mediaId,
        trackId: targetTrack.id,
        type: 'video',
        start,
        duration: meta.duration,
        fit: 'contain'
      })
      p.clips.push(clip)
      saveProject(p)
      return ok(
        `FX gerado e adicionado [${clip.id}] em ${start.toFixed(2)}s na faixa ${targetTrack.id}. Arquivo: ${rendered.outputPath}\nComposição editável: ${rendered.sourcePath}`
      )
    } catch (e: any) {
      return fail(`Falha ao gerar FX: ${e?.message || e}`)
    }
  }
)

// ---- render ----
server.registerTool(
  'render',
  {
    title: 'Exportar vídeo (MP4)',
    description: 'Renderiza a timeline atual num arquivo MP4 (com transições, texto, enhance e áudio).',
    inputSchema: { outputPath: z.string().describe('Caminho .mp4 de saída.') }
  },
  async ({ outputPath }) => {
    const res = await renderProject(loadProject(), outputPath)
    return res.ok ? ok(`Exportado: ${res.outputPath}`) : fail(res.error || 'Falha na exportação.')
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
