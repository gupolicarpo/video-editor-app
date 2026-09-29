import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditor } from '../store'
import type { Clip, MediaItem } from '../types'
import { fmtTime, clamp } from '../util'
import { previewTransition } from '../transitions'
import { computeMotion } from '../motion'
import { computeAnim, clipPathOf } from '../animations'
import { maskClipPath } from '../masks'
import { LOOKS, getLook, lookCss, lookFilterId, lookMatrix } from '../../../shared/looks'
import { clipVolumeGain } from '../../../shared/audio'
import { measureTextBox } from '../textRender'

type MediaEl = HTMLVideoElement | HTMLAudioElement | HTMLImageElement

// Recorte de bordas: algum lado com fração relevante removida.
export function hasCrop(c: Clip): boolean {
  const cr = c.crop
  if (!cr) return false
  return cr.l >= 0.001 || cr.r >= 0.001 || cr.t >= 0.001 || cr.b >= 0.001
}

// Tamanho (em % da caixa do clipe) do retângulo já recortado, enquadrado nela
// pelas mesmas regras de fit (contain/cover/fill) — espelha o cropChain do
// motor: o recorte reduz a fonte, e é ESSE retângulo menor que é enquadrado.
export function cropFrame(
  c: Clip,
  m: { width?: number; height?: number } | undefined,
  projW: number,
  projH: number
): { fw: number; fh: number } {
  const cr = c.crop
  if (!cr || !m?.width || !m?.height) return { fw: 100, fh: 100 }
  const srcW = m.width * (1 - cr.l - cr.r)
  const srcH = m.height * (1 - cr.t - cr.b)
  if (srcW <= 0 || srcH <= 0) return { fw: 100, fh: 100 }
  const aSrc = srcW / srcH
  const aBox = projW / projH
  if (c.fit === 'fill') return { fw: 100, fh: 100 }
  if (c.fit === 'cover') {
    return aSrc > aBox ? { fw: (100 * aSrc) / aBox, fh: 100 } : { fw: 100, fh: (100 * aBox) / aSrc }
  }
  // contain
  return aSrc > aBox ? { fw: 100, fh: (100 * aBox) / aSrc } : { fw: (100 * aSrc) / aBox, fh: 100 }
}

function fadeFactor(clip: Clip, t: number): number {
  const local = t - clip.start
  let f = 1
  if (clip.fadeIn > 0 && local < clip.fadeIn) f = Math.min(f, local / clip.fadeIn)
  const remain = clip.duration - local
  if (clip.fadeOut > 0 && remain < clip.fadeOut) f = Math.min(f, remain / clip.fadeOut)
  return clamp(f, 0, 1)
}

// 30ms ramp at every clip edge (mirrors the export's afade). The preview plays
// each clip in its own <video>, so at a clip join one element's audio stops dead
// and the next starts dead — a pop. This ramps the volume through the join, and
// because a clip fades IN from silence it also masks the seek glitch when its
// <video> is (re)positioned at activation. Applied to VOLUME only — putting it on
// opacity too would flash black at every boundary.
const MICRO_FADE = 0.03
function audioGain(clip: Clip, t: number): number {
  const local = t - clip.start
  const remain = clip.duration - local
  const maxF = Math.max(0.001, clip.duration / 2)
  const fin = Math.min(clip.fadeIn > 0 ? clip.fadeIn : MICRO_FADE, maxF)
  const fout = Math.min(clip.fadeOut > 0 ? clip.fadeOut : MICRO_FADE, maxF)
  let f = 1
  if (local < fin) f = Math.min(f, local / fin)
  if (remain < fout) f = Math.min(f, remain / fout)
  return clamp(f, 0, 1)
}

function cssFilter(clip: Clip): string {
  const base = `brightness(${(1 + clip.brightness).toFixed(3)}) contrast(${clip.contrast.toFixed(3)}) saturate(${clip.saturation.toFixed(3)})`
  const look = getLook(clip.look)
  // Same order the engine uses in eqOf(): manual eq first, then the look.
  return look ? `${base} ${lookCss(look)}` : base
}

/**
 * The <filter> elements the looks reference. Mounted once, hidden.
 *
 * `color-interpolation-filters="sRGB"` is load-bearing: the SVG default is
 * linearRGB, which would silently grade in a different space than ffmpeg's
 * colorchannelmixer and put the preview several codes off the export.
 */
function LookFilterDefs(): JSX.Element {
  return (
    <svg aria-hidden width="0" height="0" style={{ position: 'absolute' }}>
      <defs>
        {LOOKS.filter((l) => l.id !== 'none').map((l) => {
          const m = lookMatrix(l)
          const values = [
            m[0], m[1], m[2], 0, 0,
            m[3], m[4], m[5], 0, 0,
            m[6], m[7], m[8], 0, 0,
            0, 0, 0, 1, 0
          ].join(' ')
          return (
            <filter key={l.id} id={lookFilterId(l.id)} colorInterpolationFilters="sRGB">
              <feColorMatrix type="matrix" values={values} />
            </filter>
          )
        })}
      </defs>
    </svg>
  )
}

// Só monta mídia PERTO da agulha. Antes todo clipe era um <video>/<img> vivo no
// DOM ao mesmo tempo; com muitas faixas (e <video> segurando decoder mesmo
// pausado) o preview se arrastava.
//
// Era ±1,5s. O pré-aquecimento do próximo clipe só pode começar depois que o
// elemento existe, e um seek em master long-GOP custa 300-600ms — com 1,5s o
// elemento entrava ativo ainda sem quadro decodificado e a tela piscava preto a
// cada corte. Em módulo (não no corpo do componente) porque `sync` é um
// useCallback com deps [] declarado antes deste ponto.
//
// 4s travou o playback: numa rajada de cortes curtos isso mantinha 3-4 <video>
// de 1080p vivos ao mesmo tempo, cada um segurando um decoder. 2,5s ainda cobre
// o pior seek medido (600ms) com folga, e só UM elemento é pré-aquecido por vez
// (ver proximoId em sync) — o custo era o seek simultâneo, não a janela em si.
const MOUNT_WINDOW = 2.5

export function Preview(): JSX.Element {
  const clips = useEditor((s) => s.clips)
  const media = useEditor((s) => s.media)
  const projectW = useEditor((s) => s.projectW)
  const projectH = useEditor((s) => s.projectH)
  const masterVolume = useEditor((s) => s.masterVolume)
  const isPlaying = useEditor((s) => s.isPlaying)
  const setPlaying = useEditor((s) => s.setPlaying)
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const select = useEditor((s) => s.select)

  const refs = useRef<Map<string, MediaEl>>(new Map())
  const proxyAudioRefs = useRef<Map<string, HTMLAudioElement>>(new Map())
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioBoosts = useRef<
    Map<HTMLMediaElement, { source: MediaElementAudioSourceNode; gain: GainNode; pan: StereoPannerNode }>
  >(new Map())
  const rafRef = useRef<number>(0)
  const lastTs = useRef<number>(0)
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageH, setStageH] = useState(360)
  const [cropMode, setCropMode] = useState(false)

  const mediaById = useCallback((id: string) => media.find((m) => m.id === id), [media])

  const activateAudio = useCallback((): void => {
    // latencyHint 'playback': buffer maior no grafo de áudio (ganho/pan para
    // volume >100% e pan). O padrão 'interactive' usa buffer mínimo e é o
    // primeiro a picotar quando o áudio passa por dispositivos virtuais
    // (Voicemeeter, NVIDIA Broadcast) ou uma interface USB. Editor de vídeo
    // não precisa de latência de instrumento.
    if (!audioContextRef.current) audioContextRef.current = new AudioContext({ latencyHint: 'playback' })
    void audioContextRef.current.resume().catch(() => {})
  }, [])

  // HTMLMediaElement.volume stops at 1 and has no pan control at all. The
  // timeline permits 200% volume and ±1 pan, so route anything that needs
  // either through a Gain→StereoPanner graph. Plain clips (100% vol, center
  // pan) keep the native <audio>.volume path, avoiding a WebAudio graph for
  // the common case. StereoPannerNode implements the Web Audio spec's pan
  // law itself (equal-power for mono sources, linear crossfade for stereo) —
  // matched on the export side in ffmpeg.ts rather than re-derived here, so
  // "preview is export" holds without hand-rolling the curve twice.
  const setPreviewAudio = useCallback((el: HTMLMediaElement, volume: number, pan: number): void => {
    const level = Math.max(0, volume)
    const p = Math.max(-1, Math.min(1, pan))
    let boost = audioBoosts.current.get(el)
    if (!boost && (level > 1 || p !== 0)) {
      activateAudio()
      const context = audioContextRef.current!
      try {
        const source = context.createMediaElementSource(el)
        const gain = context.createGain()
        const panner = context.createStereoPanner()
        source.connect(gain).connect(panner).connect(context.destination)
        boost = { source, gain, pan: panner }
        audioBoosts.current.set(el, boost)
      } catch {
        // Browsers can reject a second source for the same element. Native
        // volume still handles 0..100% / centered pan in that rare case.
        el.volume = 1
        return
      }
    }
    if (boost) {
      el.volume = 1
      boost.gain.gain.value = level
      boost.pan.pan.value = p
    } else {
      el.volume = Math.min(1, level)
    }
  }, [activateAudio])

  const releaseAudioBoost = useCallback((el: MediaEl | null | undefined): void => {
    if (!el || el.tagName === 'IMG') return
    const mediaEl = el as HTMLMediaElement
    const boost = audioBoosts.current.get(mediaEl)
    if (!boost) return
    try {
      boost.source.disconnect()
      boost.gain.disconnect()
      boost.pan.disconnect()
    } catch {
      /* already disconnected */
    }
    audioBoosts.current.delete(mediaEl)
  }, [])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setStageH(el.clientHeight))
    ro.observe(el)
    setStageH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  // Trocar a seleção sai do modo recorte (a moldura de recorte é por clipe).
  useEffect(() => {
    setCropMode(false)
  }, [selectedClipId])

  const sync = useCallback((t: number, playing: boolean, hard = false) => {
    const st = useEditor.getState()

    // OCLUSÃO. O Chromium reparte um orçamento fixo de decodificação entre
    // todos os <video> tocando (medido com os proxies reais: ~200 quadros/s no
    // total; a partir de 3 vídeos 720p60 cada um cai para 30-40 fps e o preview
    // "pula"). Esconder NÃO ajuda — vídeo com visibility:hidden ou display:none
    // continuou decodificando a ~30 q/s no teste. Só PAUSAR devolve o orçamento.
    // Neste projeto havia até 6 vídeos empilhados cobrindo a tela inteira: só o
    // de cima aparece, os outros 5 eram decodificados à toa (348 s no total).
    // Regra: o clipe visual mais alto que cobre o palco por inteiro, opaco e sem
    // nada que recorte ou mova a sua caixa, esconde tudo que está embaixo. Os
    // vídeos cobertos ficam pausados; o SOM deles continua pelo <audio> irmão.
    const ativosVis = st.clips
      .filter((c) => (c.type === 'video' || c.type === 'image') && t >= c.start && t < c.start + c.duration)
      .map((c) => ({ c, ord: st.trackOrder(c.trackId) }))
      .sort((a, b) => b.ord - a.ord) // de cima para baixo
    const razaoPalco = st.projectW / st.projectH
    const cobre = (c: Clip): boolean => {
      if (c.opacity * fadeFactor(c, t) < 0.999) return false
      if (c.scale < 1 || Math.abs(c.xFrac) > 0.005 || Math.abs(c.yFrac) > 0.005) return false
      // qualquer coisa que mexa na forma ou no alfa da caixa: não confiar
      if (c.rotate || c.mask || c.anim || c.transition || (c.effects && c.effects.length)) return false
      if (hasCrop(c)) return false
      const m = st.media.find((x) => x.id === c.mediaId)
      if (!m || !m.width || !m.height) return false
      if (c.fit === 'cover') return true
      return Math.abs(m.width / m.height - razaoPalco) < 0.01
    }
    const cobertos = new Set<string>()
    {
      const i = ativosVis.findIndex((x) => cobre(x.c))
      if (i >= 0) for (const x of ativosVis.slice(i + 1)) if (x.c.type === 'video') cobertos.add(x.c.id)
    }

    // The primary active video (bottom-most video track) is the playback clock.
    // Nunca um coberto: ele fica pausado e travaria o relógio.
    let masterId: string | null = null
    if (playing && !hard) {
      let best: { id: string; ord: number } | null = null
      for (const c of st.clips) {
        if (c.type !== 'video' || t < c.start || t >= c.start + c.duration) continue
        if (cobertos.has(c.id)) continue
        const ord = st.trackOrder(c.trackId)
        if (!best || ord < best.ord) best = { id: c.id, ord }
      }
      masterId = best?.id ?? null
    }
    const anySolo = st.tracks.some((tr) => tr.solo)
    const trackSilenced = (trackId: string): boolean => {
      const tr = st.tracks.find((x) => x.id === trackId)
      if (!tr) return false
      return !!tr.muted || (anySolo && !tr.solo)
    }
    // ENTREGA ENTRE CLIPES. Um <video> visível sem quadro decodificado pinta
    // transparente, e o fundo preto do palco aparece — era o "preto em várias
    // partes" durante o play, um piscão a cada corte. Antes de mexer em
    // visibilidade, descobrir se ALGUM clipe visual ativo já tem quadro:
    //   - tem ativo e algum pronto  -> troca normal
    //   - tem ativo e nenhum pronto -> segura o quadro anterior na tela
    //   - nenhum ativo              -> buraco de verdade na timeline, limpa
    // Sem isto o clipe que sai some antes de o que entra ter o que mostrar.
    // Só os que realmente aparecem contam; um coberto nunca "segura" a tela.
    const ativos = ativosVis.map((x) => x.c).filter((c) => !cobertos.has(c.id))
    const temAtivo = ativos.length > 0
    const algumPronto = ativos.some((c) => {
      const e = refs.current.get(c.id)
      if (!e) return false
      if (e.tagName === 'IMG') return (e as HTMLImageElement).complete
      const v = e as HTMLMediaElement
      return v.readyState >= 2 && !v.seeking
    })
    const podeEsconder = !temAtivo || algumPronto

    // Pré-aquecer TODOS os clipes montados disparava vários seeks de 1080p ao
    // mesmo tempo (300-600ms cada) e travava o playback. Só o PRÓXIMO importa:
    // o de menor distância à frente da agulha que já tenha elemento montado.
    let proximoId: string | null = null
    if (playing) {
      let menor = Infinity
      for (const c of st.clips) {
        if (c.type !== 'video') continue
        const ahead = c.start - t
        if (ahead <= 0 || ahead >= MOUNT_WINDOW || ahead >= menor) continue
        if (!refs.current.has(c.id)) continue
        menor = ahead
        proximoId = c.id
      }
    }

    for (const clip of st.clips) {
      if (clip.type === 'text') continue
      const el = refs.current.get(clip.id)
      if (!el) continue
      const proxyAudio = proxyAudioRefs.current.get(clip.id)
      const active = t >= clip.start && t < clip.start + clip.duration
      const isImg = el.tagName === 'IMG'
      const av = el as HTMLMediaElement
      if (active) {
        const coberto = cobertos.has(clip.id)
        // Coberto e MUDO (ou com o som vindo do <audio> irmão): pausa, devolve
        // o orçamento de decodificação. Coberto mas audível: só esconde — pausar
        // mataria o som, e um <audio> separado lendo o MP4 original picotava.
        const silencioso =
          trackSilenced(clip.trackId) || clipVolumeGain(clip.volume) * st.masterVolume * audioGain(clip, t) <= 0
        const pausaCoberto = coberto && (!!proxyAudio || silencioso)
        // Só revela quando há quadro para mostrar. Enquanto o decode não chega,
        // o clipe anterior continua na tela (ver podeEsconder).
        const pronto = isImg ? (el as HTMLImageElement).complete : av.readyState >= 2 && !av.seeking
        if (coberto) {
          if (podeEsconder && el.style.visibility !== 'hidden') el.style.visibility = 'hidden'
        } else if (pronto && el.style.visibility !== 'visible') el.style.visibility = 'visible'
        el.style.opacity = String(clip.opacity * fadeFactor(clip, t))
        el.style.filter = cssFilter(clip)
        if (!isImg) {
          const desired = clip.inPoint + (t - clip.start) * clip.speed
          // Audio drift is audible well before video drift is visible — keep a
          // much tighter tolerance for <audio> elements (seek there is cheap).
          // The MASTER video is never seeked while playing: the playhead follows
          // it (see tick), and seeking the clock against itself on long-GOP
          // masters is what caused the stall storms.
          const isMaster =
            playing && !hard && el.tagName === 'VIDEO' && masterId !== null && clip.id === masterId
          const tolerance = hard || !playing ? 0.02 : el.tagName === 'AUDIO' ? 0.08 : 0.35
          // Um coberto está pausado de propósito: corrigir a posição dele a cada
          // quadro seria um seek por quadro — a tempestade de seeks de volta.
          // Ele se acerta com um único seek quando voltar a aparecer.
          if (!isMaster && !pausaCoberto && Math.abs(av.currentTime - desired) > tolerance) av.currentTime = desired
          if (av.playbackRate !== clip.speed) av.playbackRate = clip.speed
          const volume = trackSilenced(clip.trackId)
            ? 0
            : clipVolumeGain(clip.volume) * st.masterVolume * audioGain(clip, t)
          if (proxyAudio) av.volume = 0
          else setPreviewAudio(av, volume, clip.pan)
          if (playing && !pausaCoberto && av.paused) av.play().catch(() => {})
          if ((!playing || pausaCoberto) && !av.paused) av.pause()
          if (proxyAudio) {
            const audioTolerance = hard || !playing ? 0.02 : 0.08
            if (Math.abs(proxyAudio.currentTime - desired) > audioTolerance) proxyAudio.currentTime = desired
            if (proxyAudio.playbackRate !== clip.speed) proxyAudio.playbackRate = clip.speed
            setPreviewAudio(proxyAudio, volume, clip.pan)
            if (playing && proxyAudio.paused) proxyAudio.play().catch(() => {})
            if (!playing && !proxyAudio.paused) proxyAudio.pause()
          }
        }
      } else {
        if (podeEsconder && el.style.visibility !== 'hidden') el.style.visibility = 'hidden'
        if (!isImg && !av.paused) av.pause()
        if (proxyAudio && !proxyAudio.paused) proxyAudio.pause()
        // Pré-aquece o clipe que vai entrar: posiciona o <video> no primeiro
        // quadro que vai mostrar, para a ativação ser um play() com o quadro já
        // decodificado, e não um seek-e-toca.
        //
        // Era 0,3s de antecedência — menos que o próprio custo do seek, medido
        // em 300-600ms em master long-GOP (ver SCRUB SETTLING abaixo). O clipe
        // entrava ativo ainda sem quadro. Agora o pré-aquecimento começa assim
        // que o elemento é montado (MOUNT_WINDOW). O `!av.seeking` evita
        // reemitir o seek a cada quadro enquanto o anterior ainda corre.
        if (!isImg && playing && clip.id === proximoId) {
          if (!av.seeking && Math.abs(av.currentTime - clip.inPoint) > 0.05) {
            av.currentTime = clip.inPoint
          }
        }
      }
    }
  }, [])

  useEffect(() => {
    if (!isPlaying) {
      cancelAnimationFrame(rafRef.current)
      sync(useEditor.getState().playhead, false)
      return
    }
    sync(useEditor.getState().playhead, true, true)
    lastTs.current = performance.now()
    // THE MEDIA IS THE CLOCK. The old tick advanced a wall clock and dragged the
    // videos after it with seeks; on our masters (keyframe every ~5.7s) each
    // drift-seek stalls the decoder for dozens of frames, the wall clock keeps
    // marching, drift grows, another seek fires — a seek storm that looked like
    // "video can't keep up with audio". Now the playhead FOLLOWS the currentTime
    // of the active primary video (bottom-most video track = main footage), whose
    // element keeps its own A/V in perfect sync and is never seeked while
    // playing. Wall-clock time only drives sections with no active video.
    const pickMaster = (st: ReturnType<typeof useEditor.getState>, t: number) => {
      const actives = st.clips.filter(
        (c) => c.type === 'video' && t >= c.start && t < c.start + c.duration
      )
      if (!actives.length) return null
      actives.sort((a, b) => st.trackOrder(a.trackId) - st.trackOrder(b.trackId))
      return actives[0]
    }
    const tick = (now: number) => {
      const dt = (now - lastTs.current) / 1000
      lastTs.current = now
      const st = useEditor.getState()
      let next = st.playhead + dt
      const master = pickMaster(st, st.playhead)
      if (master) {
        const el = refs.current.get(master.id) as HTMLVideoElement | undefined
        if (el && el.readyState >= 2 && !el.seeking) {
          const mediaT = master.start + (el.currentTime - master.inPoint) / Math.max(0.05, master.speed)
          // Follow the element unless it's wildly off (fresh mount mid-scrub).
          if (Math.abs(mediaT - st.playhead) < 1.5) next = Math.max(st.playhead, mediaT)
        }
      }
      // Loop range (keys I/O): jump back to loopIn when passing loopOut.
      if (st.loopIn !== null && st.loopOut !== null && st.loopOut > st.loopIn && next >= st.loopOut) {
        next = st.loopIn
        st.setPlayhead(next)
        sync(next, true, true)
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      const dur = st.duration()
      if (next >= dur && dur > 0) {
        st.setPlayhead(dur)
        st.setPlaying(false)
        sync(dur, false)
        return
      }
      st.setPlayhead(next)
      sync(next, true)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying])

  const playhead = useEditor((s) => s.playhead)
  // SCRUB SETTLING. The flight recorder caught 78 main-thread stalls — every
  // one with playing=false: dragging the needle fired an immediate seek on every
  // active video per mousemove tick, and on long-GOP masters each seek costs
  // 300-600ms. While dragging, the needle now moves free; the expensive seeks
  // (and clip mounting) fire once, 120ms after the hand stops.
  const [settled, setSettled] = useState(playhead)
  useEffect(() => {
    if (isPlaying) return
    const t = setTimeout(() => setSettled(playhead), 120)
    return () => clearTimeout(t)
  }, [playhead, isPlaying])
  useEffect(() => {
    if (!isPlaying) sync(settled, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, clips, masterVolume, isPlaying])

  const mountT = isPlaying ? playhead : settled
  const nearPlayhead = (c: Clip): boolean =>
    mountT >= c.start - MOUNT_WINDOW && mountT <= c.start + c.duration + MOUNT_WINDOW
  // MONTAR UMA VEZ, NUNCA DESMONTAR. Antes só os clipes a ±2,5 s da agulha
  // tinham elemento; cada clipe que entrava na janela criava um <video>/<audio>
  // novo (Chromium abre o arquivo do zero: ffmpeg_demuxer OnOpenContextDone,
  // segundos de CPU num worker) e cada um que saía destruía o dele. Trace
  // real da parte de música: 29 aberturas em 8 s, 130 s de trabalho somado,
  // 43 threads ocupadas — o compositor da tela ficava na fila atrás e a
  // thread principal esperava 1,1 s por quadro (WaitForCommitCompletion).
  // Agora cada clipe tem seu elemento durante toda a sessão; longe da agulha
  // ele fica pausado com preload=metadata (só o demuxer aberto, sem decoder).
  const visual = clips
    .filter((c) => c.type === 'video' || c.type === 'image' || c.type === 'text')
    .map((c) => ({ c, order: useEditor.getState().trackOrder(c.trackId) }))
    .sort((a, b) => a.order - b.order || a.c.start - b.c.start)
  const audioClips = clips.filter((c) => c.type === 'audio')
  // TODO vídeo toca o som por um <audio> irmão, e o <video> fica sempre mudo.
  // Antes só as gravações multifaixa (audioPath) faziam isso. Separar som de
  // imagem é o que permite PAUSAR o <video> de um clipe coberto (ver oclusão em
  // sync) sem o áudio dele sumir — e decodificar só o áudio de um MP4 é barato.
  // Companheiro <audio> SÓ para gravações multifaixa (audioPath = mix já
  // pronto, arquivo pequeno). Tentei dar um <audio> a todo vídeo lendo o MP4
  // original: um <audio> num MP4 lê o vídeo inteiro intercalado só para
  // chegar ao som — 6 deles em paralelo (dezenas de MB/s) deixaram o
  // decodificador de áudio sem dado e o som saiu picotado. O vídeo toca o
  // próprio som; o que está coberto e audível continua tocando, só escondido.
  const videoAudioClips = clips.filter((c) => c.type === 'video' && !!mediaById(c.mediaId)?.audioPath)

  // Ref callbacks must be IDENTITY-STABLE per clip. An inline `(el) => ...` is a
  // new function every render, and React then detaches/reattaches the ref each
  // render — which ran the destructive cleanup below against LIVE elements and
  // blanked every video on screen. Cached per id, null only means real unmount.
  const refCbs = useRef<Map<string, (el: MediaEl | null) => void>>(new Map())
  const setRef = (id: string): ((el: MediaEl | null) => void) => {
    let cb = refCbs.current.get(id)
    if (!cb) {
      cb = (el) => {
        if (el) {
          refs.current.set(id, el)
          return
        }
        // Real unmount: a detached <video> still PLAYING is protected from GC by
        // Chromium and keeps decoding forever (measured: 912 MB of ghosts). Stop
        // it and drop the source before releasing the reference.
        const old = refs.current.get(id)
        if (old && old.tagName !== 'IMG') {
          const av = old as HTMLMediaElement
          try {
            releaseAudioBoost(old)
            av.pause()
            av.removeAttribute('src')
            av.load()
          } catch {
            /* already gone */
          }
        }
        refs.current.delete(id)
      }
      refCbs.current.set(id, cb)
    }
    return cb
  }

  const proxyRefCbs = useRef<Map<string, (el: HTMLAudioElement | null) => void>>(new Map())
  const setProxyAudioRef = (id: string): ((el: HTMLAudioElement | null) => void) => {
    let cb = proxyRefCbs.current.get(id)
    if (!cb) {
      cb = (el) => {
        if (el) {
          proxyAudioRefs.current.set(id, el)
          return
        }
        const old = proxyAudioRefs.current.get(id)
        if (old) {
          try {
            releaseAudioBoost(old)
            old.pause()
            old.removeAttribute('src')
            old.load()
          } catch {
            /* already gone */
          }
        }
        proxyAudioRefs.current.delete(id)
      }
      proxyRefCbs.current.set(id, cb)
    }
    return cb
  }

  // Vignette (and grain) are stage-level overlays here, while the engine bakes
  // them per clip. Identical for a full-frame clip — which is every case they
  // are used in — and already how the vignette effect behaved before looks.
  const stageVignette = visual.reduce((mx, { c }) => {
    const active = playhead >= c.start && playhead < c.start + c.duration
    if (!active) return mx
    return Math.max(mx, computeMotion(c, playhead).vignette, getLook(c.look)?.vignette ?? 0)
  }, 0)
  const stageGrain = visual.reduce((mx, { c }) => {
    const active = playhead >= c.start && playhead < c.start + c.duration
    return active ? Math.max(mx, getLook(c.look)?.grain ?? 0) : mx
  }, 0)

  const dur = useEditor.getState().duration()
  const selected = clips.find((c) => c.id === selectedClipId)
  // selVisual liga a MOLDURA de seleção (mover/redimensionar) — inclui texto.
  // O recorte de bordas só faz sentido em vídeo/imagem: selCropavel.
  // (Uma alteração anterior tirou o texto daqui para esconder o botão de
  // recorte e, sem querer, tirou a moldura do texto junto.)
  const selVisual =
    selected && (selected.type === 'video' || selected.type === 'image' || selected.type === 'text')
  const selCropavel = selected && (selected.type === 'video' || selected.type === 'image')
  const selectedActive =
    selected && playhead >= selected.start && playhead < selected.start + selected.duration

  return (
    <div className="preview">
      <div className="stage-wrap">
        <div className="stage" ref={stageRef} style={{ aspectRatio: `${projectW} / ${projectH}` }}>
          <LookFilterDefs />
          {visual.length === 0 && <div className="stage-empty">Pré-visualização</div>}
          {visual.map(({ c, order }) => {
            const active = playhead >= c.start && playhead < c.start + c.duration
            if (c.type === 'text') {
              return (
                <TextLayer
                  key={c.id}
                  clip={c}
                  order={order}
                  stageH={stageH}
                  visible={active}
                  playing={isPlaying}
                  selected={c.id === selectedClipId}
                  stageRef={stageRef}
                />
              )
            }
            const m = mediaById(c.mediaId)
            if (!m) return null
            const box = boxStyle(c, order)
            const tr = previewTransition(c, playhead)
            if (tr.active) {
              if (tr.transform) box.transform = tr.transform
              if (tr.clipPath) box.clipPath = tr.clipPath
              if (tr.opacity !== undefined) box.opacity = tr.opacity
            }
            // motion effects (zoom punch, ken burns, pan, tilt, shake…)
            const mo = computeMotion(c, playhead)
            if (mo.scale !== 1 || mo.dx || mo.dy || mo.rotate) {
              const motionT = `scale(${mo.scale.toFixed(4)}) translate(${(mo.dx / 19.2).toFixed(3)}%, ${(mo.dy / 10.8).toFixed(3)}%) rotate(${mo.rotate.toFixed(2)}deg)`
              box.transform = `${motionT} ${box.transform || ''}`.trim()
            }
            // element animations (in / loop / out)
            const an = computeAnim(c, playhead)
            // O giro FIXO soma ao giro da animacao e sai na MESMA posicao da
            // cadeia (girar antes de escalar), que e a ordem do export — sem
            // isso preview e arquivo final divergiriam.
            const rotDeg = an.rotate + (c.rotate ?? 0)
            if (an.scaleX !== 1 || an.scaleY !== 1 || an.tx || an.ty || rotDeg) {
              const animT = `translate(${an.tx.toFixed(3)}%, ${an.ty.toFixed(3)}%) scale(${an.scaleX.toFixed(4)}, ${an.scaleY.toFixed(4)}) rotate(${rotDeg.toFixed(2)}deg)`
              box.transform = `${animT} ${box.transform || ''}`.trim()
            }
            if (an.opacity !== 1) {
              const base = box.opacity === undefined ? 1 : Number(box.opacity)
              box.opacity = base * an.opacity
            }
            // `wipe` reveals via a mask, so it must not override a transition's clip-path.
            const animClip = clipPathOf(an)
            if (animClip && !box.clipPath) box.clipPath = animClip
            // Shape mask (narrator-in-a-circle). Only when nothing else already
            // claimed the clip-path, and combined via the box's own clip.
            const maskClip = maskClipPath(c.mask)
            if (maskClip && !box.clipPath) box.clipPath = maskClip
            const cssFilters: string[] = []
            if (mo.blur > 0) cssFilters.push(`blur(${mo.blur}px)`)
            if (mo.grayscale > 0) cssFilters.push(`grayscale(${mo.grayscale})`)
            if (cssFilters.length) box.filter = cssFilters.join(' ')
            // Todas as mídias ficam montadas o tempo todo (ver MONTAR UMA VEZ);
            // a caixa de um clipe fora da agulha é transparente mas ocupa o
            // palco — sem isto ela roubava o clique/arrasto da moldura de
            // seleção de um texto ou clipe embaixo dela.
            if (!(playhead >= c.start && playhead < c.start + c.duration)) box.pointerEvents = 'none'
            const inner: React.CSSProperties = {
              width: '100%',
              height: '100%',
              objectFit: c.fit,
              opacity: c.opacity,
              visibility: 'hidden'
            }
            return (
              <div
                key={c.id}
                // Marked so the app-wide "click outside clears the selection"
                // handler treats this as a selecting click, instead of relying
                // on stopPropagation below (which does not run during playback).
                className="stage-layer"
                style={box}
                onMouseDown={(e) => {
                  if (!isPlaying) {
                    e.stopPropagation()
                    select(c.id)
                  }
                }}
              >
                {hasCrop(c) ? (
                  (() => {
                    const { fw, fh } = cropFrame(c, m, projectW, projectH)
                    const cr = c.crop!
                    const wrap: React.CSSProperties = {
                      position: 'absolute',
                      left: `${50 - fw / 2}%`,
                      top: `${50 - fh / 2}%`,
                      width: `${fw}%`,
                      height: `${fh}%`,
                      overflow: 'hidden'
                    }
                    const cropped: React.CSSProperties = {
                      ...inner,
                      position: 'absolute',
                      width: `${100 / (1 - cr.l - cr.r)}%`,
                      height: `${100 / (1 - cr.t - cr.b)}%`,
                      left: `${(-100 * cr.l) / (1 - cr.l - cr.r)}%`,
                      top: `${(-100 * cr.t) / (1 - cr.t - cr.b)}%`,
                      objectFit: 'fill',
                      maxWidth: 'none'
                    }
                    return (
                      <div style={wrap}>
                        {m.type === 'image' ? (
                          <img ref={setRef(c.id)} src={window.api.mediaUrl(m.path)} style={cropped} draggable={false} />
                        ) : (
                          <video
                            ref={setRef(c.id)}
                            src={window.api.mediaUrl(m.editProxyPath || m.path)}
                            style={cropped}
                            preload={nearPlayhead(c) ? 'auto' : 'metadata'}
                            playsInline
                            muted={!!m.audioPath}
                          />
                        )}
                      </div>
                    )
                  })()
                ) : m.type === 'image' ? (
                  <img ref={setRef(c.id)} src={window.api.mediaUrl(m.path)} style={inner} draggable={false} />
                ) : (
                  <video
                    ref={setRef(c.id)}
                    src={window.api.mediaUrl(m.editProxyPath || m.path)}
                    style={inner}
                    preload={nearPlayhead(c) ? 'auto' : 'metadata'}
                    playsInline
                    muted={!!m.audioPath}
                  />
                )}
              </div>
            )
          })}

          {stageVignette > 0 && <div className="vignette-overlay" style={{ opacity: stageVignette }} />}
          {/* Grain has no exact CSS twin for ffmpeg's per-pixel `noise`; this is
              a matched-density stand-in so the look reads right while editing. */}
          {stageGrain > 0 && <div className="grain-overlay" style={{ opacity: stageGrain * 0.5 }} />}

          {selected && selVisual && selectedActive && (
            <SelectionOverlay
              clip={selected}
              stageRef={stageRef}
              cropMode={cropMode && !!selCropavel}
              media={mediaById(selected.mediaId)}
            />
          )}
        </div>
      </div>

      <div style={{ display: 'none' }}>
        {audioClips.map((c) => {
          const m = mediaById(c.mediaId)
          if (!m) return null
          return <audio key={c.id} ref={setRef(c.id)} src={window.api.mediaUrl(c.audioSourcePath || m.audioPath || m.path)} preload={nearPlayhead(c) ? 'auto' : 'metadata'} />
        })}
        {videoAudioClips.map((c) => {
          const m = mediaById(c.mediaId)
          if (!m?.audioPath) return null
          return <audio key={`${c.id}:mixed-audio`} ref={setProxyAudioRef(c.id)} src={window.api.mediaUrl(m.audioPath)} preload={nearPlayhead(c) ? 'auto' : 'metadata'} />
        })}
      </div>

      <div className="transport">
        <button className="btn" onClick={() => useEditor.getState().setPlayhead(0)} title="Início">
          ⏮
        </button>
        <button className="btn btn-primary" onClick={() => { activateAudio(); setPlaying(!isPlaying) }}>
          {isPlaying ? '⏸ Pausar' : '▶ Reproduzir'}
        </button>
        {selCropavel && (
          <button
            className={cropMode ? 'btn btn-primary' : 'btn'}
            onClick={() => setCropMode((v) => !v)}
            title="Recortar bordas do clipe"
          >
            ✂ Recortar
          </button>
        )}
        <span className="time-readout">
          {fmtTime(playhead)} / {fmtTime(dur)}
        </span>
        <AudioMeter t={playhead} />
      </div>
    </div>
  )
}

// Approximate output level at time t, derived from each audible clip's
// precomputed peak envelope × volume × fades × track mute/solo. No WebAudio
// graph — zero risk of rerouting/silencing real playback.
function AudioMeter({ t }: { t: number }): JSX.Element | null {
  const peakHold = useRef(0)
  const st = useEditor.getState()
  const anySolo = st.tracks.some((tr) => tr.solo)
  let sum = 0
  for (const clip of st.clips) {
    if (clip.type !== 'audio' && clip.type !== 'video') continue
    if (t < clip.start || t >= clip.start + clip.duration) continue
    if (clip.volume <= 0) continue
    const tr = st.tracks.find((x) => x.id === clip.trackId)
    if (tr && (tr.muted || (anySolo && !tr.solo))) continue
    const m = st.media.find((x) => x.id === clip.mediaId)
    if (!m?.peaks?.length || !m.hasAudio) continue
    const srcT = clip.inPoint + (t - clip.start) * clip.speed
    const idx = Math.max(0, Math.min(m.peaks.length - 1, Math.floor((srcT / m.duration) * m.peaks.length)))
    sum += m.peaks[idx] * Math.min(1, clipVolumeGain(clip.volume) * st.masterVolume) * fadeFactor(clip, t)
  }
  const level = Math.min(1, sum)
  peakHold.current = Math.max(level, peakHold.current * 0.96)
  const color = level > 0.9 ? '#f0683c' : level > 0.7 ? '#e6b84a' : '#4ade6c'
  return (
    <div className="audio-meter" title="Nível de áudio (aprox.)">
      <div className="audio-meter-fill" style={{ width: `${level * 100}%`, background: color }} />
      <div className="audio-meter-peak" style={{ left: `${peakHold.current * 100}%` }} />
    </div>
  )
}

function TextLayer({
  clip,
  order,
  stageH,
  visible,
  playing,
  selected,
  stageRef
}: {
  clip: Clip
  order: number
  stageH: number
  visible: boolean
  playing: boolean
  selected: boolean
  stageRef: React.RefObject<HTMLDivElement>
}): JSX.Element | null {
  const t = clip.text
  const update = useEditor((s) => s.updateClip)
  const select = useEditor((s) => s.select)
  if (!t) return null
  const fontSize = t.fontSizeRel * stageH
  const playheadNow = useEditor.getState().playhead
  const tr = previewTransition(clip, playheadNow)
  const an = computeAnim(clip, playheadNow)
  const opacity =
    clip.opacity *
    fadeFactor(clip, playheadNow) *
    (tr.active && tr.opacity !== undefined ? tr.opacity : 1) *
    an.opacity
  const rotDeg = an.rotate + (clip.rotate ?? 0)
  const animT =
    an.scaleX !== 1 || an.scaleY !== 1 || an.tx || an.ty || rotDeg
      ? ` translate(${an.tx.toFixed(3)}%, ${an.ty.toFixed(3)}%) scale(${an.scaleX.toFixed(4)}, ${an.scaleY.toFixed(4)}) rotate(${rotDeg.toFixed(2)}deg)`
      : ''

  function startDrag(e: React.MouseEvent): void {
    if (playing) return
    e.stopPropagation()
    e.preventDefault()
    select(clip.id)
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return
    useEditor.getState().commit()
    const sx = e.clientX
    const sy = e.clientY
    const ox = clip.xFrac
    const oy = clip.yFrac
    const onMove = (ev: MouseEvent) => {
      update(clip.id, {
        xFrac: clamp(ox + (ev.clientX - sx) / rect.width, -1, 1),
        yFrac: clamp(oy + (ev.clientY - sy) / rect.height, -1, 1)
      })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${50 + clip.xFrac * 100}%`,
    top: `${50 + clip.yFrac * 100}%`,
    transform: `translate(-50%, -50%)${animT} ${tr.transform || ''}`,
    clipPath: tr.clipPath || clipPathOf(an),
    zIndex: order,
    maxWidth: `${Math.min(94, 200 * Math.min(0.5 + clip.xFrac, 0.5 - clip.xFrac)).toFixed(2)}%`,
    textAlign: t.align,
    color: t.color,
    fontFamily: t.fontFamily,
    fontWeight: t.bold ? 700 : 400,
    fontStyle: t.italic ? 'italic' : 'normal',
    fontSize: `${fontSize}px`,
    lineHeight: 1.25,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    padding: t.bgColor ? `${fontSize * 0.25}px ${fontSize * 0.4}px` : 0,
    background: t.bgColor || 'transparent',
    opacity,
    visibility: visible ? 'visible' : 'hidden',
    cursor: playing ? 'default' : 'move',
    outline: selected ? '1.5px dashed var(--accent-2)' : 'none',
    WebkitTextStroke: t.outline ? `${Math.max(1, fontSize * 0.03)}px rgba(0,0,0,0.85)` : undefined,
    textShadow: t.outline ? '0 2px 6px rgba(0,0,0,0.5)' : undefined,
    userSelect: 'none'
  }
  return (
    <div style={style} onMouseDown={startDrag}>
      {t.content}
    </div>
  )
}

function boxStyle(c: Clip, order: number): React.CSSProperties {
  const wPct = c.scale * 100
  const hPct = c.scale * 100
  const leftPct = 50 + c.xFrac * 100 - wPct / 2
  const topPct = 50 + c.yFrac * 100 - hPct / 2
  return {
    position: 'absolute',
    left: `${leftPct}%`,
    top: `${topPct}%`,
    width: `${wPct}%`,
    height: `${hPct}%`,
    zIndex: order,
    overflow: 'hidden'
  }
}

function SelectionOverlay({
  clip,
  stageRef,
  cropMode,
  media
}: {
  clip: Clip
  stageRef: React.RefObject<HTMLDivElement>
  cropMode?: boolean
  media?: MediaItem
}): JSX.Element {
  const update = useEditor((s) => s.updateClip)
  const projectW = useEditor((s) => s.projectW)
  const projectH = useEditor((s) => s.projectH)
  let wPct = clip.scale * 100
  let hPct = clip.scale * 100
  let leftPct = 50 + clip.xFrac * 100 - wPct / 2
  let topPct = 50 + clip.yFrac * 100 - hPct / 2
  // TEXTO: a moldura abraça o texto de verdade (mesma medição do export), e
  // não a caixa `scale` — texto não usa `scale` para nada, seu tamanho é
  // `fontSizeRel`. Era por isso que puxar a alça não mudava o texto.
  if (clip.type === 'text') {
    const b = measureTextBox(clip, projectW, projectH)
    if (b) {
      leftPct = (b.left / projectW) * 100
      topPct = (b.top / projectH) * 100
      wPct = ((b.right - b.left) / projectW) * 100
      hPct = ((b.bottom - b.top) / projectH) * 100
    }
  }

  function startMove(e: React.MouseEvent): void {
    e.stopPropagation()
    e.preventDefault()
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return
    useEditor.getState().commit()
    const startX = e.clientX
    const startY = e.clientY
    const ox = clip.xFrac
    const oy = clip.yFrac
    const onMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startX) / rect.width
      const dy = (ev.clientY - startY) / rect.height
      update(clip.id, { xFrac: clamp(ox + dx, -1.5, 1.5), yFrac: clamp(oy + dy, -1.5, 1.5) })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function startResize(e: React.MouseEvent): void {
    e.stopPropagation()
    e.preventDefault()
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return
    useEditor.getState().commit()
    const cx = rect.left + rect.width * (0.5 + clip.xFrac)
    const cy = rect.top + rect.height * (0.5 + clip.yFrac)
    // Texto: a alça muda o TAMANHO DA FONTE, proporcional a quanto o canto se
    // afastou do centro desde o início do arraste. Mesmos limites do slider.
    const texto = clip.type === 'text' ? clip.text : undefined
    const d0 = Math.max(4, Math.hypot(e.clientX - cx, e.clientY - cy))
    const f0 = texto?.fontSizeRel ?? 0
    const onMove = (ev: MouseEvent) => {
      if (texto) {
        const d = Math.hypot(ev.clientX - cx, ev.clientY - cy)
        update(clip.id, { text: { ...texto, fontSizeRel: clamp((f0 * d) / d0, 0.02, 0.3) } })
        return
      }
      const dxFrac = Math.abs(ev.clientX - cx) / rect.width
      const dyFrac = Math.abs(ev.clientY - cy) / rect.height
      update(clip.id, { scale: clamp(Math.max(dxFrac, dyFrac) * 2, 0.05, 4) })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('blur', onUp)
  }

  // Modo recorte: a moldura é o quadro já enquadrado (fw/fh, em % da caixa do
  // clipe), e as alças de borda ajustam l/r/t/b diretamente — mesma lógica do
  // cropFrame/cropChain do motor.
  function startCrop(side: 'n' | 's' | 'e' | 'w', e: React.MouseEvent): void {
    e.stopPropagation()
    e.preventDefault()
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return
    useEditor.getState().commit()
    const cr0 = clip.crop ?? { l: 0, r: 0, t: 0, b: 0 }
    const { fw, fh } = cropFrame(clip, media, projectW, projectH)
    // Largura/altura exibida da FONTE INTEIRA (sem recorte), em pixels, no
    // início do arraste — é contra isso que o delta do mouse vira fração.
    const pxW0 = (rect.width * wPct) / 100 * fw / 100 / (1 - cr0.l - cr0.r)
    const pxH0 = (rect.height * hPct) / 100 * fh / 100 / (1 - cr0.t - cr0.b)
    const sx = e.clientX
    const sy = e.clientY
    const onMove = (ev: MouseEvent) => {
      const dx = pxW0 > 0 ? (ev.clientX - sx) / pxW0 : 0
      const dy = pxH0 > 0 ? (ev.clientY - sy) / pxH0 : 0
      let { l, r, t, b } = cr0
      if (side === 'w') l = cr0.l + dx
      if (side === 'e') r = cr0.r - dx
      if (side === 'n') t = cr0.t + dy
      if (side === 's') b = cr0.b - dy
      l = clamp(l, 0, 0.9)
      r = clamp(r, 0, 0.9)
      t = clamp(t, 0, 0.9)
      b = clamp(b, 0, 0.9)
      if (l + r > 0.9) {
        if (side === 'w') r = 0.9 - l
        else l = 0.9 - r
      }
      if (t + b > 0.9) {
        if (side === 'n') b = 0.9 - t
        else t = 0.9 - b
      }
      update(clip.id, { crop: { l, r, t, b } })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('blur', onUp)
  }

  if (cropMode) {
    const { fw, fh } = cropFrame(clip, media, projectW, projectH)
    const cropLeft = leftPct + (wPct * (50 - fw / 2)) / 100
    const cropTop = topPct + (hPct * (50 - fh / 2)) / 100
    const cropW = (wPct * fw) / 100
    const cropH = (hPct * fh) / 100
    const sides: Array<'n' | 's' | 'e' | 'w'> = ['n', 's', 'e', 'w']
    return (
      <div
        className="sel-frame"
        style={{ left: `${cropLeft}%`, top: `${cropTop}%`, width: `${cropW}%`, height: `${cropH}%` }}
      >
        {sides.map((side) => (
          <div key={side} className={`sel-handle ${side}`} onMouseDown={(e) => startCrop(side, e)} />
        ))}
      </div>
    )
  }

  const corners = ['nw', 'ne', 'se', 'sw'] as const
  return (
    <div
      className="sel-frame"
      style={{ left: `${leftPct}%`, top: `${topPct}%`, width: `${wPct}%`, height: `${hPct}%` }}
      onMouseDown={startMove}
    >
      {corners.map((pos) => (
        <div key={pos} className={`sel-handle ${pos}`} onMouseDown={startResize} />
      ))}
    </div>
  )
}
