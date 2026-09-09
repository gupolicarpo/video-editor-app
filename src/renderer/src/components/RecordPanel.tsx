import { useEffect, useRef, useState, useCallback } from 'react'
import { nanoid } from 'nanoid'
import { useEditor } from '../store'
import type { MediaItem } from '../types'

interface Device {
  deviceId: string
  label: string
}

type LockState = 'auto' | 'travando' | 'travado' | 'nao-suportado'

const RES = [
  { label: '1080p', w: 1920, h: 1080 },
  { label: '720p', w: 1280, h: 720 }
] as const

/**
 * Locks exposure, focus and white balance.
 *
 * `applyConstraints({ advanced: [{ exposureMode: 'manual' }] })` *resolves
 * successfully* on a C920 and leaves the camera on `continuous`: advanced
 * constraints are best-effort and dropped in silence. The mode only sticks when
 * the corresponding value ships with it. So we send both, then read the settings
 * back — the promise resolving proves nothing.
 *
 * It matters because a hunting auto-exposure shifts luminance between frames,
 * and a matte's alpha edge shifts with it. A flickering edge reads as fake long
 * before an imperfect one does.
 */
async function lockCamera(track: MediaStreamTrack): Promise<LockState> {
  const s = track.getSettings() as MediaTrackSettings & {
    exposureTime?: number
    focusDistance?: number
    colorTemperature?: number
  }
  const pairs: Array<Record<string, unknown>> = [
    { exposureMode: 'manual', exposureTime: s.exposureTime },
    { focusMode: 'manual', focusDistance: s.focusDistance },
    { whiteBalanceMode: 'manual', colorTemperature: s.colorTemperature }
  ]
  for (const c of pairs) {
    if (Object.values(c)[1] === undefined) continue
    try {
      await track.applyConstraints({ advanced: [c] } as MediaTrackConstraints)
    } catch {
      /* keep going: a partial lock still beats none */
    }
  }
  const after = track.getSettings() as MediaTrackSettings & {
    exposureMode?: string
    focusMode?: string
    whiteBalanceMode?: string
  }
  const locked = [after.exposureMode, after.focusMode, after.whiteBalanceMode].filter(
    (m) => m === 'manual'
  ).length
  return locked === 3 ? 'travado' : locked > 0 ? 'travando' : 'nao-suportado'
}

// Prefere sempre um codec com codificador de HARDWARE. Ordem medida nesta
// maquina (1080p30, 600 quadros pedidos): avc1/NVENC 557, VP8 578, VP9 201.
// O VP9 nao tem NVENC na NVIDIA — cai no libvpx da CPU e a captura desaba.
function escolheMime(comAudio: boolean): string {
  const cands = comAudio
    ? ['video/x-matroska;codecs=avc1,opus', 'video/webm;codecs=h264,opus',
       'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
    : ['video/x-matroska;codecs=avc1', 'video/webm;codecs=h264',
       'video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm']
  return cands.find((t) => MediaRecorder.isTypeSupported(t)) ?? 'video/webm'
}

export function RecordPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [cams, setCams] = useState<Device[]>([])
  const [mics, setMics] = useState<Device[]>([])
  const [camId, setCamId] = useState('')
  const [micId, setMicId] = useState('')
  const [res, setRes] = useState<(typeof RES)[number]>(RES[0])
  const [lock, setLock] = useState<LockState>('auto')
  const [live, setLive] = useState<string>('')
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  // fps real da captura, contado quadro a quadro no preview
  const [fpsVivo, setFpsVivo] = useState(0)
  const [fpsMin, setFpsMin] = useState(0)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [hasBroadcast, setHasBroadcast] = useState(false)
  const [savedCount, setSavedCount] = useState(0)
  // Free-floating position of the panel. null = still centered by CSS; once the
  // user grabs the title bar we switch to explicit coordinates so it can be
  // dragged anywhere — including onto a second monitor. Recording keeps the
  // window alive and movable (see the compact bar below), which is the whole
  // point: you can park it out of frame and capture the screen behind it.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  // Manual collapse to the compact bar, on demand — not only during recording.
  const [collapsed, setCollapsed] = useState(false)
  // 'cam' = webcam only · 'screen' = screen + camera PiP (tutorial) ·
  // 'screenonly' = screen with mic, no camera at all.
  const [mode, setMode] = useState<'cam' | 'screen' | 'screenonly'>('cam')
  // Both screen modes share the desktop-capture plumbing; only the camera PiP
  // and where the mic rides differ. This keeps every `mode === 'screen'` guard
  // that concerns the desktop feed working for the new mode too.
  const isScreen = mode === 'screen' || mode === 'screenonly'
  const [screens, setScreens] = useState<Array<{ id: string; name: string }>>([])
  const [screenId, setScreenId] = useState('')
  // som do sistema (gameplay): loopback do Windows, misturado ao microfone
  const [sysAudio, setSysAudio] = useState(false)
  const [sysGain, setSysGain] = useState(0.6)
  const mixRef = useRef<{ ctx: AudioContext; sys: GainNode | null } | null>(null)
  // ids dos fluxos de gravação em disco (um por MediaRecorder)
  const fluxoRef = useRef<string | null>(null)
  const fluxoTelaRef = useRef<string | null>(null)
  const filaRef = useRef<Promise<unknown>>(Promise.resolve())

  const videoRef = useRef<HTMLVideoElement>(null)
  // <video> minusculo e sempre montado, so para contar quadros: o preview
  // grande some quando o painel vira barra compacta, que e justamente como
  // se grava jogo.
  const medidorRef = useRef<HTMLVideoElement>(null)
  const camPipRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)
  const recRef = useRef<MediaRecorder | null>(null)
  const screenRecRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const screenChunksRef = useRef<Blob[]>([])
  const contaRef = useRef(0)
  const fpsRef = useRef(30)
  const screenFpsRef = useRef(30)
  const addRecording = useEditor((s) => s.addRecording)
  const addDualRecording = useEditor((s) => s.addDualRecording)

  // Device labels stay empty until a capture permission is granted, so we take a
  // throwaway stream first to unlock the names. Use AUDIO ONLY: opening video
  // here would grab the default camera (the C920), and if NVIDIA Broadcast is
  // holding it exclusively that throws "device in use" — which used to abort the
  // whole panel before the Broadcast virtual camera could even be listed. Mic
  // permission unlocks the camera labels too, without touching the busy camera.
  const listDevices = useCallback(async () => {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
      probe.getTracks().forEach((t) => t.stop())
    } catch (e) {
      setError('Sem acesso ao microfone: ' + (e as Error).message)
      // still enumerate — labels may be blank but the picker works
    }
    const all = await navigator.mediaDevices.enumerateDevices()
    const v = all.filter((d) => d.kind === 'videoinput').map((d) => ({ deviceId: d.deviceId, label: d.label }))
    const a = all
      .filter((d) => d.kind === 'audioinput' && !/^(default|communications)$/i.test(d.deviceId))
      .map((d) => ({ deviceId: d.deviceId, label: d.label }))
    setCams(v)
    setMics(a)
    // Prefer the NVIDIA Broadcast virtual device (live GPU background removal +
    // noise removal) when present — it's the "clean feed, zero wait" path and
    // needs no code from us, it just shows up as a normal device. Fall back to
    // the real webcam, then anything.
    const bc = (d: Device): boolean => /nvidia broadcast/i.test(d.label)
    setHasBroadcast(v.some(bc) || a.some(bc))
    const preferCam = v.find(bc) ?? v.find((d) => /c9\d\d|pro webcam/i.test(d.label)) ?? v[0]
    setCamId((c) => c || preferCam?.deviceId || '')
    const preferMic = a.find(bc) ?? a.find((d) => /c9\d\d|pro webcam/i.test(d.label)) ?? a[0]
    setMicId((m) => m || preferMic?.deviceId || '')
  }, [])

  useEffect(() => {
    void listDevices()
    return () => streamRef.current?.getTracks().forEach((t) => t.stop())
  }, [listDevices])

  // (Re)open the selected devices whenever the choice changes.
  useEffect(() => {
    // Screen-only never touches the camera — the mic is captured alongside the
    // desktop feed instead (see the screen-capture effect). Opening the camera
    // here would just spin it up for nothing and could collide with Broadcast.
    if (!camId || mode === 'screenonly') return
    let cancelled = false
    ;(async () => {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      setLock('auto')
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: camId },
            width: { ideal: res.w },
            height: { ideal: res.h },
            frameRate: { ideal: 30 }
          },
          audio: micId ? { deviceId: { exact: micId }, echoCancellation: false, noiseSuppression: false } : true
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        // In screen mode the big preview belongs to the screen; the camera goes
        // to the round PiP instead.
        if (mode === 'cam' && videoRef.current) videoRef.current.srcObject = stream
        if (mode === 'screen' && camPipRef.current) camPipRef.current.srcObject = stream
        const t = stream.getVideoTracks()[0]
        const st = t.getSettings()
        fpsRef.current = st.frameRate ?? 30
        setLive(`${st.width}×${st.height} @ ${st.frameRate}fps`)
        setError('')
      } catch (e) {
        const err = e as Error
        const busy = err.name === 'NotReadableError' || /in use|readable/i.test(err.message)
        const isC920 = /c9\d\d|pro webcam/i.test(cams.find((c) => c.deviceId === camId)?.label ?? '')
        setError(
          busy && isC920
            ? 'A câmera está ocupada pelo NVIDIA Broadcast. Selecione "★ Camera (NVIDIA Broadcast)" acima — é o feed já com fundo removido.'
            : busy
              ? 'Câmera em uso por outro programa. Feche-o ou escolha outra fonte.'
              : 'Não abriu a câmera: ' + err.message
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [camId, micId, res, mode])

  useEffect(() => {
    if (!recording) return
    const t = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(t)
  }, [recording])

  // Screen mode: list capturable screens/windows once, then open the chosen one.
  useEffect(() => {
    if (!isScreen) {
      screenStreamRef.current?.getTracks().forEach((t) => t.stop())
      screenStreamRef.current = null
      return
    }
    void window.api.screenSources().then((list) => {
      setScreens(list)
      setScreenId((id) => id || list.find((l) => l.id.startsWith('screen'))?.id || list[0]?.id || '')
    })
  }, [isScreen])

  useEffect(() => {
    if (!isScreen || !screenId) return
    let cancelled = false
    ;(async () => {
      screenStreamRef.current?.getTracks().forEach((t) => t.stop())
      // o mixer pertence ao stream anterior: fecha junto para não vazar
      mixRef.current?.ctx.close().catch(() => {})
      mixRef.current = null
      try {
        // Chromium's desktop capture: the source id comes from desktopCapturer
        // in the main process. In tutorial mode audio stays off here (the mic
        // rides the camera stream — capturing both would double the room
        // sound). In screen-only there IS no camera stream, so the mic has to
        // ride the desktop feed, and it's grabbed separately and grafted on
        // below (desktop capture can't take an audio deviceId itself).
        // Com som do sistema é obrigatório passar por getDisplayMedia: o
        // caminho chromeMediaSource:'desktop' do getUserMedia não entrega
        // áudio nenhum. Sem som do sistema mantemos o caminho antigo, que já
        // estava verificado.
        let stream: MediaStream
        if (sysAudio) {
          await window.api.setDisplaySource(screenId)
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: 30 },
            // Sem estas quatro o Chromium entrega o som do sistema em MONO e
            // com cancelamento de eco, supressao de ruido e ganho automatico
            // ligados — o que destroi musica e efeito de jogo. Medido: na forma
            // simples as constraints colam; com {exact:...} o getDisplayMedia
            // lanca TypeError.
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
              channelCount: 2
            }
          })
        } else {
          stream = await (navigator.mediaDevices as any).getUserMedia({
            audio: false,
            video: {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: screenId,
                maxFrameRate: 30
              }
            }
          })
        }
        if (cancelled) {
          stream.getTracks().forEach((t: MediaStreamTrack) => t.stop())
          return
        }
        if (mode === 'screenonly' || sysAudio) {
          try {
            const mic = await navigator.mediaDevices.getUserMedia({
              audio: micId
                ? { deviceId: { exact: micId }, echoCancellation: false, noiseSuppression: false }
                : true
            })
            if (cancelled) {
              mic.getTracks().forEach((t) => t.stop())
              stream.getTracks().forEach((t: MediaStreamTrack) => t.stop())
              return
            }
            const doSistema = stream.getAudioTracks()
            if (doSistema.length === 0) {
              // sem loopback (ex.: fora do Windows): só o microfone
              mic.getAudioTracks().forEach((t) => stream.addTrack(t))
            } else {
              // O MediaRecorder grava UMA faixa de áudio só — faixas extras são
              // descartadas em silêncio. Por isso microfone e sistema têm de ser
              // somados no Web Audio antes de chegar ao gravador.
              const ctx = new AudioContext()
              const dest = ctx.createMediaStreamDestination()
              const gSys = ctx.createGain()
              gSys.gain.value = sysGain
              ctx.createMediaStreamSource(new MediaStream(doSistema)).connect(gSys).connect(dest)
              const gMic = ctx.createGain()
              gMic.gain.value = 1
              ctx.createMediaStreamSource(new MediaStream(mic.getAudioTracks())).connect(gMic).connect(dest)
              mixRef.current = { ctx, sys: gSys }
              doSistema.forEach((t) => stream.removeTrack(t))
              dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t))
            }
          } catch {
            // Sem microfone não é fatal: sobra o som do sistema (ou o silêncio).
          }
        }
        screenStreamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
        if (mode === 'screen' && camPipRef.current && streamRef.current)
          camPipRef.current.srcObject = streamRef.current
        const st = stream.getVideoTracks()[0].getSettings()
        screenFpsRef.current = st.frameRate ?? 30
        setError('')
      } catch (e) {
        setError('Não abriu a captura de tela: ' + (e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [mode, isScreen, screenId, micId, sysAudio])

  // O slider ajusta o som do sistema durante a gravação, sem refazer o stream.
  useEffect(() => {
    if (mixRef.current?.sys) mixRef.current.sys.gain.value = sysGain
  }, [sysGain])

  // Leaving screen mode puts the camera back on the main preview.
  useEffect(() => {
    if (mode === 'cam' && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current
    }
  }, [mode])

  const doLock = async (): Promise<void> => {
    const t = streamRef.current?.getVideoTracks()[0]
    if (!t) return
    setLock('travando')
    setLock(await lockCamera(t))
  }

  // Medidor de fps ao vivo. O <video> do preview e alimentado pela mesma
  // trilha que vai para o MediaRecorder, entao contar os quadros que chegam
  // nele mede a captura de verdade — nao o que foi PEDIDO em getSettings().
  useEffect(() => {
    if (!recording) return
    const v = medidorRef.current as (HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number
      cancelVideoFrameCallback?: (h: number) => void
    }) | null
    if (!v?.requestVideoFrameCallback) return
    contaRef.current = 0
    let vivo = true
    let h = 0
    const tick = (): void => {
      if (!vivo) return
      contaRef.current++
      h = v.requestVideoFrameCallback!(tick)
    }
    h = v.requestVideoFrameCallback(tick)
    let primeira = true
    const iv = window.setInterval(() => {
      const n = contaRef.current
      contaRef.current = 0
      setFpsVivo(n)
      // o primeiro segundo pega a partida do encoder; nao conta para o minimo
      if (primeira) primeira = false
      else setFpsMin((m) => (m === 0 ? n : Math.min(m, n)))
    }, 1000)
    return () => {
      vivo = false
      if (v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(h)
      window.clearInterval(iv)
    }
  }, [recording])

  const start = async (): Promise<void> => {
    // Screen-only records the desktop feed (mic already grafted on); every
    // other mode records the camera stream as the primary take.
    const stream = mode === 'screenonly' ? screenStreamRef.current : streamRef.current
    if (!stream) return
    const dual = mode === 'screen'
    if (dual && !screenStreamRef.current) return
    chunksRef.current = []
    screenChunksRef.current = []
    // H.264 em Matroska usa o codificador de HARDWARE (NVENC). O VP9 nao tem
    // NVENC nesta placa: ia para o libvpx na CPU e derrubava a captura.
    // Medido a 1080p30 com a maquina ociosa: VP9 gravou 201 dos 600 quadros
    // pedidos (33%), avc1 gravou 557 (93%). Sob carga de jogo o VP9 caiu a 2fps.
    const mime = escolheMime(true)
    // Os pedaços vão para o disco assim que chegam. Antes eles ficavam num
    // array e viravam um Blob único no fim: com mais de ~2 GB (12 min de tela
    // a 14 Mbps) o arrayBuffer() falhava e a gravação inteira se perdia.
    const stampFluxo = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    filaRef.current = Promise.resolve()
    const grava = (id: string | null, b: Blob): void => {
      if (!id) return
      filaRef.current = filaRef.current
        .then(() => b.arrayBuffer())
        .then((buf) => window.api.recordStreamChunk(id, buf))
        .catch(() => { /* um pedaço perdido não pode derrubar a gravação */ })
    }
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 })
    fluxoRef.current = await window.api.recordStreamOpen(
      mode === 'screenonly' ? `tela-${stampFluxo}` : `gravacao-${stampFluxo}`
    )
    rec.ondataavailable = (e) => e.data.size && grava(fluxoRef.current, e.data)
    recRef.current = rec
    if (dual) {
      const srec = new MediaRecorder(screenStreamRef.current!, {
        mimeType: escolheMime(false),
        videoBitsPerSecond: 14_000_000
      })
      fluxoTelaRef.current = await window.api.recordStreamOpen(`tela-${stampFluxo}`)
      srec.ondataavailable = (e) => e.data.size && grava(fluxoTelaRef.current, e.data)
      screenRecRef.current = srec
      // both stopped -> persist the pair together
      let stopped = 0
      const onBoth = (): void => {
        stopped += 1
        if (stopped === 2) void persistDual()
      }
      rec.onstop = onBoth
      srec.onstop = onBoth
      // start in the same tick so the two takes line up (sub-frame skew)
      srec.start(1000)
      rec.start(1000)
    } else {
      rec.onstop = () => void persist()
      rec.start(1000)
    }
    // no modo duplo o que desaba e a TELA, nao a camera — mede a tela
    if (medidorRef.current) medidorRef.current.srcObject = screenStreamRef.current ?? stream
    setElapsed(0)
    setFpsVivo(0)
    setFpsMin(0)
    setRecording(true)
  }

  const stop = (): void => {
    recRef.current?.stop()
    screenRecRef.current?.stop()
    screenRecRef.current = null
    setRecording(false)
  }

  const persistDual = async (): Promise<void> => {
    setBusy('Salvando tela + câmera…')
    try {
      await filaRef.current // espera os últimos pedaços chegarem ao disco
      const fechar = async (id: string | null, fps: number, hasAudio: boolean) => {
        if (!id) throw new Error('gravação sem arquivo aberto')
        const r = await window.api.recordStreamClose({ id, fps, hasAudio })
        if (!r.ok || !r.rec) {
          throw new Error(
            (r.error || 'falha ao normalizar') +
              (r.raw ? ` — o arquivo bruto está salvo em: ${r.raw}` : '')
          )
        }
        return r.rec
      }
      const [scr, cam] = await Promise.all([
        fechar(fluxoTelaRef.current, screenFpsRef.current, false),
        fechar(fluxoRef.current, fpsRef.current, true)
      ])
      fluxoTelaRef.current = null
      fluxoRef.current = null
      const nomeDe = (p: string): string => p.split(/[\/]/).pop() ?? 'gravação'
      const item = (r: typeof scr, name: string): MediaItem => ({
        id: nanoid(8),
        name,
        path: r.path,
        type: 'video',
        duration: r.duration,
        width: r.width,
        height: r.height,
        hasAudio: r.hasAudio,
        hasVideo: true,
        fps: r.fps
      })
      addDualRecording(item(scr, nomeDe(scr.path)), item(cam, nomeDe(cam.path)))
      setBusy('')
      setSavedCount((n) => n + 1)
    } catch (e) {
      setBusy('')
      setError('Falhou ao salvar: ' + (e as Error).message)
    }
  }

  const persist = async (): Promise<void> => {
    setBusy('Salvando e normalizando…')
    try {
      await filaRef.current // espera o último pedaço chegar ao disco
      const id = fluxoRef.current
      if (!id) throw new Error('gravação sem arquivo aberto')
      // Screen-only: the recorded stream is the desktop feed, so its fps and
      // its (grafted-on) mic track are what matter — not the camera's.
      const primary = mode === 'screenonly' ? screenStreamRef.current : streamRef.current
      const res = await window.api.recordStreamClose({
        id,
        fps: mode === 'screenonly' ? screenFpsRef.current : fpsRef.current,
        hasAudio: (primary?.getAudioTracks().length ?? 0) > 0
      })
      fluxoRef.current = null
      if (!res.ok || !res.rec) {
        throw new Error(
          (res.error || 'falha ao normalizar') +
            (res.raw ? ` — o arquivo bruto está salvo em: ${res.raw}` : '')
        )
      }
      const rec = res.rec
      const item: MediaItem = {
        id: nanoid(8),
        name: rec.path.split(/[\\/]/).pop() ?? 'gravação',
        path: rec.path,
        type: 'video',
        duration: rec.duration,
        width: rec.width,
        height: rec.height,
        hasAudio: rec.hasAudio,
        hasVideo: true,
        fps: rec.fps
      }
      addRecording(item)
      setBusy('')
      // Keep the panel open so you can immediately record the next take — the
      // camera stream stays live. Just bump the saved count as confirmation.
      setSavedCount((n) => n + 1)
    } catch (e) {
      setBusy('')
      setError('Falhou ao salvar: ' + (e as Error).message)
    }
  }

  const lockLabel: Record<LockState, string> = {
    auto: '⚠ automático (exposição, foco e branco vão oscilar)',
    travando: '◐ travado em parte — nem todos os controles aceitaram',
    travado: '✓ exposição, foco e branco travados',
    'nao-suportado': '✗ esta câmera não deixa travar'
  }

  // Drag from the title bar. Uses window pointer listeners so the drag keeps
  // tracking even if the cursor outruns the panel, and clamps just enough of
  // the bar to stay on-screen that you can always grab it back.
  const startDrag = (e: React.PointerEvent): void => {
    const panel = (e.currentTarget as HTMLElement).closest('.record-panel') as HTMLElement | null
    if (!panel) return
    const rect = panel.getBoundingClientRect()
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    if (!pos) setPos({ x: rect.left, y: rect.top })
    const move = (ev: PointerEvent): void => {
      if (!dragRef.current) return
      const x = Math.min(window.innerWidth - 60, Math.max(-panel.offsetWidth + 120, ev.clientX - dragRef.current.dx))
      const y = Math.min(window.innerHeight - 40, Math.max(0, ev.clientY - dragRef.current.dy))
      setPos({ x, y })
    }
    const up = (): void => {
      dragRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Once floating (dragged) or recording, drop the full-screen dark backdrop —
  // it would block the very screen you're trying to record, and pin the panel
  // in place. The panel then positions itself absolutely.
  // Compact bar shows the setup is hidden: either recording (forced) or the
  // user tapped the collapse button.
  const compact = recording || collapsed
  // Detach from the centering backdrop once dragged, recording, or collapsed —
  // any of those means the user wants it out of the way, not a centered modal.
  const floating = pos !== null || recording || collapsed
  const panelStyle: React.CSSProperties = pos
    ? { position: 'fixed', left: pos.x, top: pos.y, margin: 0 }
    : {}

  const shell = (
    <div
      className={`modal record-panel${floating ? ' floating' : ''}${compact ? ' compact' : ''}`}
      style={panelStyle}
      onClick={(e) => e.stopPropagation()}
    >
      <h2 className="record-drag" onPointerDown={startDrag} title="Arraste para mover">
        <span className="record-grip">⠿</span> 🎥 Gravar
        {recording && (
          <span className="record-live">
            <span className="record-live-dot" /> REC {String(Math.floor(elapsed / 60)).padStart(2, '0')}:
            {String(elapsed % 60).padStart(2, '0')}
            {fpsVivo > 0 && (
              <span
                title={
                  fpsVivo < 20
                    ? 'A captura esta perdendo quadros — feche programas pesados ou baixe a resolucao do jogo'
                    : 'quadros por segundo realmente capturados'
                }
                style={{ marginLeft: 8, fontVariantNumeric: 'tabular-nums',
                  color: fpsVivo < 20 ? '#ff5a5a' : fpsVivo < 26 ? '#ffb020' : '#7ee081' }}
              >
                {fpsVivo} fps{fpsMin > 0 && fpsMin < 20 ? ` (min ${fpsMin})` : ''}
              </span>
            )}
          </span>
        )}
        {/* Manual collapse/expand. Hidden while recording, which already forces
            the compact bar (and the setup can't change mid-take anyway). */}
        {!recording && (
          <button
            className="record-collapse"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? 'Expandir' : 'Colapsar (barra pequena)'}
          >
            {collapsed ? '▢' : '—'}
          </button>
        )}
      </h2>

      <video
        ref={medidorRef}
        autoPlay
        muted
        playsInline
        style={{ position: 'absolute', width: 2, height: 2, opacity: 0, pointerEvents: 'none' }}
      />

      {/* Everything below is setup — hidden while recording, or when the user
          collapses the panel, so it shrinks to a compact draggable REC bar you
          can park in a corner instead of a full window blocking the capture. */}
      {!compact && (
        <>
        <div style={{ position: 'relative' }}>
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            style={{ width: '100%', borderRadius: 8, background: '#000', aspectRatio: '16 / 9' }}
          />
          {mode === 'screen' && (
            <video
              ref={camPipRef}
              autoPlay
              muted
              playsInline
              style={{
                position: 'absolute',
                right: 10,
                bottom: 10,
                width: '24%',
                aspectRatio: '1 / 1',
                objectFit: 'cover',
                borderRadius: '50%',
                border: '2px solid rgba(255,255,255,0.6)',
                background: '#000'
              }}
            />
          )}
        </div>

        <div className="field">
          <label>Modo</label>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as 'cam' | 'screen' | 'screenonly')}
            disabled={recording}
          >
            <option value="cam">🎥 Só câmera</option>
            <option value="screenonly">🖥 Só tela</option>
            <option value="screen">🖥 Tela + câmera (tutorial)</option>
          </select>
        </div>

        {isScreen && (
          <div className="field">
            <label>Tela / janela</label>
            <select value={screenId} onChange={(e) => setScreenId(e.target.value)} disabled={recording}>
              {screens.map((sc) => (
                <option key={sc.id} value={sc.id}>
                  {sc.id.startsWith('screen') ? '🖥 ' : '🪟 '}
                  {sc.name.slice(0, 60)}
                </option>
              ))}
            </select>
          </div>
        )}

        {isScreen && (
          <div className="field">
            <label className="check-line">
              <input
                type="checkbox"
                checked={sysAudio}
                onChange={(e) => setSysAudio(e.target.checked)}
                disabled={recording}
              />
              🔊 Gravar o som do sistema (gameplay)
            </label>
            {sysAudio && (
              <>
                <div className="sys-mix">
                  <span>Jogo</span>
                  <input
                    type="range"
                    min={0}
                    max={1.5}
                    step={0.05}
                    value={sysGain}
                    onChange={(e) => setSysGain(Number(e.target.value))}
                  />
                  <b>{Math.round(sysGain * 100)}%</b>
                </div>
                <p className="hint">
                  O som do jogo entra junto com a sua voz numa faixa só. Use fone
                  — na caixa de som o microfone capta o jogo de novo e ele sai
                  dobrado e com eco.
                </p>
              </>
            )}
          </div>
        )}

        {mode !== 'screenonly' && (
          <div className="field">
            <label>Câmera</label>
            <select value={camId} onChange={(e) => setCamId(e.target.value)} disabled={recording}>
              {cams.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {(/nvidia broadcast/i.test(d.label) ? '★ ' : '') + (d.label || 'Câmera sem nome')}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="field">
          <label>Microfone</label>
          <select value={micId} onChange={(e) => setMicId(e.target.value)} disabled={recording}>
            {mics.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {(/nvidia broadcast/i.test(d.label) ? '★ ' : '') + (d.label || 'Microfone sem nome')}
              </option>
            ))}
          </select>
        </div>

        {hasBroadcast ? (
          <p className="hint">
            ★ <b>NVIDIA Broadcast</b> disponível — as fontes marcadas já saem processadas na GPU ao
            vivo (fundo removido, ruído cancelado). Para a <b>câmera</b>, abra o Broadcast e ative a
            aba <b>Câmera</b>; ela então aparece aqui como fonte.{' '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault()
                void window.api.openBroadcast().then((ok) => {
                  if (!ok) setError('NVIDIA Broadcast não encontrado no caminho padrão.')
                  else setTimeout(() => void listDevices(), 3000)
                })
              }}
            >
              Abrir NVIDIA Broadcast
            </a>
          </p>
        ) : (
          <p className="hint">
            Dica: o <b>NVIDIA Broadcast</b> remove o fundo ao vivo na sua RTX e aparece aqui como uma
            câmera — abra o app dele e ative a aba Câmera.
          </p>
        )}

        <div className="field">
          <label>Resolução {live && <span className="hint">— entregando {live}</span>}</label>
          <select
            value={res.label}
            onChange={(e) => setRes(RES.find((r) => r.label === e.target.value) ?? RES[0])}
            disabled={recording}
          >
            {RES.map((r) => (
              <option key={r.label} value={r.label}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        {/* No camera in screen-only, so nothing to lock exposure/focus on. */}
        {mode !== 'screenonly' && (
          <div className="field">
            <button className="btn" onClick={doLock} disabled={recording || lock === 'travado'}>
              🔒 Travar câmera
            </button>
            <p className="hint">{lockLabel[lock]}</p>
          </div>
        )}

        </>
      )}

        {error && <p className="ai-error">{error}</p>}
        {busy && <p className="hint">{busy}</p>}
        {!recording && !busy && savedCount > 0 && (
          <p className="ok">
            ✓ {savedCount} {savedCount === 1 ? 'gravação salva' : 'gravações salvas'} na timeline —
            pode gravar a próxima.
          </p>
        )}

        <div className="modal-actions">
          {!recording && (
            <button className="btn" onClick={onClose}>
              {savedCount > 0 ? 'Concluir' : 'Fechar'}
            </button>
          )}
          {!recording ? (
            <button className="btn btn-primary" onClick={() => void start()} disabled={!streamRef.current || !!busy}>
              {savedCount > 0 ? '● Gravar de novo' : '● Gravar'}
            </button>
          ) : (
            <button className="btn btn-primary" onClick={stop}>
              ■ Parar ({String(Math.floor(elapsed / 60)).padStart(2, '0')}:
              {String(elapsed % 60).padStart(2, '0')})
            </button>
          )}
        </div>
    </div>
  )

  // Floating (dragged or recording): no backdrop, so the panel can sit anywhere
  // — even off this window, over another monitor — without dimming or blocking
  // the screen being captured. Otherwise, the usual centered modal with a
  // click-away backdrop.
  return floating ? (
    shell
  ) : (
    <div className="modal-backdrop" onClick={onClose}>
      {shell}
    </div>
  )
}
