import { useEffect, useRef, useState } from 'react'
import { Toolbar } from './components/Toolbar'
import { LibraryPanel } from './components/LibraryPanel'
import type { LibTab } from './components/LibraryPanel'
import { Preview } from './components/Preview'
import { Timeline } from './components/Timeline'
import { Inspector } from './components/Inspector'
import type { InspTab } from './components/Inspector'
import { SettingsModal } from './components/SettingsModal'
import { ExportModal } from './components/ExportModal'
import { SessionsModal } from './components/SessionsModal'
import { RecordPanel } from './components/RecordPanel'
import { useEditor } from './store'
import type { ProjectData } from './types'

export default function App(): JSX.Element {
  const [libTab, setLibTab] = useState<LibTab>('arquivos')
  const [inspectorTabRequest, setInspectorTabRequest] = useState<{ tab: InspTab; nonce: number } | null>(
    null
  )
  const [showSettings, setShowSettings] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showSessions, setShowSessions] = useState(false)
  const [showRecord, setShowRecord] = useState(false)
  // "Foco" hides BOTH side panels at once — a single button rather than the
  // old per-side collapse, since the point is a distraction-free preview, not
  // reclaiming a few hundred pixels from one side.
  const [focus, setFocus] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState('')
  const [externalEditApplied, setExternalEditApplied] = useState(false)
  const splitAtPlayhead = useEditor((s) => s.splitAtPlayhead)
  const selectedClipId = useEditor((s) => s.selectedClipId)
  const setPlaying = useEditor((s) => s.setPlaying)
  const isPlaying = useEditor((s) => s.isPlaying)
  const undo = useEditor((s) => s.undo)
  const redo = useEditor((s) => s.redo)
  const setPlayhead = useEditor((s) => s.setPlayhead)

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return
      const ctrl = e.ctrlKey || e.metaKey
      if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
        setExternalEditApplied(false)
      } else if (ctrl && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault()
        redo()
      } else if (e.code === 'Space') {
        e.preventDefault()
        setPlaying(!isPlaying)
      } else if (ctrl && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        if (e.shiftKey) useEditor.getState().ungroupSelection()
        else useEditor.getState().groupSelection()
      } else if (ctrl && e.shiftKey && e.key.toLowerCase() === 't') {
        // Trace nativo MANUAL (Ctrl+Shift+T): 8 s de tudo — mídia, áudio,
        // compositor, GPU. Para quando o som picota sem nenhuma travada
        // registrada: o disparo automático só pega travadas da thread principal.
        e.preventDefault()
        void window.api.perfLog('trace manual pedido (Ctrl+Shift+T)')
        void window.api.perfTrace(8)
      } else if (ctrl && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        useEditor.getState().copySelection()
      } else if (ctrl && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        useEditor.getState().pasteAtPlayhead()
      } else if (e.key === 's' && !ctrl) {
        splitAtPlayhead()
      } else if (e.key === 'i' && !ctrl) {
        useEditor.getState().setLoopIn(useEditor.getState().playhead)
      } else if (e.key === 'o' && !ctrl) {
        useEditor.getState().setLoopOut(useEditor.getState().playhead)
      } else if (e.key === 'u' && !ctrl) {
        useEditor.getState().clearLoop()
      } else if (e.key === 'm' && !ctrl) {
        useEditor.getState().addMarkerAtPlayhead()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && e.shiftKey) {
        // Shift now means "leave the hole" — plain Delete closes it, same as
        // trimming a clip already pulls the following ones back.
        useEditor.getState().removeSelectedKeepGap()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        useEditor.getState().removeSelected()
      } else if (e.key === 'ArrowLeft' && e.altKey) {
        e.preventDefault()
        useEditor.getState().nudgeSelected(-1 / useEditor.getState().projectFps)
      } else if (e.key === 'ArrowRight' && e.altKey) {
        e.preventDefault()
        useEditor.getState().nudgeSelected(1 / useEditor.getState().projectFps)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setPlayhead(useEditor.getState().playhead - (e.shiftKey ? 1 : 1 / useEditor.getState().projectFps))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setPlayhead(useEditor.getState().playhead + (e.shiftKey ? 1 : 1 / useEditor.getState().projectFps))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isPlaying, selectedClipId, setPlaying, splitAtPlayhead, undo, redo, setPlayhead])

  // Freeze flight recorder: a rAF heartbeat that measures real main-thread
  // Click anywhere that isn't a clip (or something that acts on the current
  // selection) clears it. Without this the Inspector kept showing a clip you
  // had mentally moved on from, and Delete still targeted it.
  //
  // The exception list is the whole point: deselecting on a click inside the
  // Inspector would empty the very panel you are trying to use, and the same
  // goes for the toolbars, the preview's selection frame, modals and the
  // library (its buttons drop a clip on the timeline and select it).
  useEffect(() => {
    const KEEP = [
      '.clip', // a timeline clip itself
      '.right-panel', // Inspector — edits the selection
      '.tl-toolbar', // Cortar / Excluir / etc. act on the selection
      '.toolbar-wrap', // top bar
      '.left-panel', // library: placing media selects the new clip
      '.modal', // dialogs
      '.sel-frame', // drag/resize handles over the preview
      '.stage-layer', // a clip clicked directly on the preview canvas
      '.track-header' // mute/solo/lock
    ].join(',')
    const onDown = (e: MouseEvent): void => {
      const el = e.target as HTMLElement | null
      if (!el || el.closest(KEEP)) return
      const st = useEditor.getState()
      if (st.selectedClipId || st.selectedClipIds.length) st.select(null)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [])

  // stalls. Anything over 300ms gets written to userData/perf.log with what the
  // app was doing, so recurring freezes leave evidence.
  useEffect(() => {
    let last = performance.now()
    let raf = 0
    // As travadas do usuário vêm em rajadas de 5-10 seguidas; perfilar os 4s
    // SEGUINTES à primeira (em vez da que já passou) pega as próximas da
    // rajada. Um cooldown de 30s evita empilhar profilers.
    let ultimoPerfil = 0
    const beat = (now: number): void => {
      const gap = now - last
      if (gap > 300) {
        const st = useEditor.getState()
        void window.api.perfLog(
          `stall ${Math.round(gap)}ms | playing=${st.isPlaying} playhead=${st.playhead.toFixed(1)} clips=${st.clips.length} media=${st.media.length}`
        )
      }
      if (gap > 700 && useEditor.getState().isPlaying && now - ultimoPerfil > 30000) {
        ultimoPerfil = now
        // trace nativo (o perfil de JS só mostrava "(program)")
        void window.api.perfTrace(4)
      }
      last = now
      raf = requestAnimationFrame(beat)
    }
    raf = requestAnimationFrame(beat)
    // Quadros PERDIDOS nos <video>, a cada 2 s durante o play. O "pulando" que o
    // usuário vê não é travada da thread principal (o batimento acima não pega)
    // — é o decodificador sem orçamento. Sem isto, semanas de "trava" sem prova.
    const drops = new WeakMap<HTMLVideoElement, number>()
    const iv = window.setInterval(() => {
      const st = useEditor.getState()
      if (!st.isPlaying) return
      let perdidos = 0
      let tocando = 0
      for (const v of document.querySelectorAll('video')) {
        if (!v.paused) tocando++
        const q = v.getVideoPlaybackQuality()
        const antes = drops.get(v)
        if (antes !== undefined) perdidos += Math.max(0, q.droppedVideoFrames - antes)
        drops.set(v, q.droppedVideoFrames)
      }
      // FOME DE BUFFER: mede diretamente onde o áudio/vídeo fica sem dado.
      // Para cada elemento tocando: quanto de mídia já carregada existe à
      // frente da posição atual e o readyState. Fome = < 0,3 s à frente ou
      // readyState < 3 (HAVE_FUTURE_DATA). É o que "picota" de verdade.
      const fome: string[] = []
      for (const el of document.querySelectorAll('video,audio') as NodeListOf<HTMLMediaElement>) {
        if (el.paused) continue
        let ahead = Infinity
        try {
          for (let i = 0; i < el.buffered.length; i++) {
            if (el.buffered.start(i) <= el.currentTime && el.currentTime <= el.buffered.end(i)) {
              ahead = el.buffered.end(i) - el.currentTime
              break
            }
          }
          if (ahead === Infinity && el.buffered.length === 0) ahead = 0
        } catch {
          /* buffered pode lançar durante troca de src */
        }
        if (el.readyState < 3 || ahead < 0.3) {
          const nome = decodeURIComponent((el.currentSrc || el.src).split(/[\/]/).pop() || '').slice(0, 40)
          fome.push(`${el.tagName.toLowerCase()} rs=${el.readyState} ahead=${ahead === Infinity ? '?' : ahead.toFixed(2)}s ${nome}`)
        }
      }
      if (fome.length) {
        void window.api.perfLog(`fome ${fome.length} | playhead=${st.playhead.toFixed(1)} | ${fome.slice(0, 4).join(' ; ')}`)
      }
      if (perdidos > 20) {
        void window.api.perfLog(
          `drops ${perdidos} em 2s | tocando=${tocando} playhead=${st.playhead.toFixed(1)} clips=${st.clips.length}`
        )
      }
    }, 2000)
    return () => {
      cancelAnimationFrame(raf)
      window.clearInterval(iv)
    }
  }, [])

  // Restore last autosaved project on startup.
  useEffect(() => {
    window.api.autosaveRead().then((data) => {
      if (data && ((data.clips && data.clips.length) || (data.media && data.media.length))) {
        useEditor.getState().loadProject(data as ProjectData)
      }
    })
  }, [])

  // Lazily compute waveforms for audio media that don't have peaks yet.
  const media = useEditor((s) => s.media)
  const timelineClips = useEditor((s) => s.clips)
  const audioProbePending = useRef(new Set<string>())
  const audioProbeQueue = useRef<Promise<void>>(Promise.resolve())
  const peakPending = useRef(new Set<string>())
  const peakQueue = useRef<Promise<void>>(Promise.resolve())

  // Older projects did not record which embedded audio streams a video used.
  // Probe only videos that are actually on the timeline, in sequence, and save
  // the combined audio path so existing projects repair themselves once.
  useEffect(() => {
    const used = new Set(timelineClips.filter((c) => c.type === 'video').map((c) => c.mediaId))
    for (const m of media) {
      if (
        m.type !== 'video' ||
        !m.hasAudio ||
        !used.has(m.id) ||
        (m.audioPath !== undefined && m.audioPaths !== undefined)
      ) continue
      if (audioProbePending.current.has(m.id)) continue
      audioProbePending.current.add(m.id)
      audioProbeQueue.current = audioProbeQueue.current
        .then(async () => {
          const meta = await window.api.probe(m.path)
          useEditor.getState().setMediaAudioPaths(m.id, meta.audioPath ?? null, meta.audioPaths ?? null)
        })
        .catch(() => useEditor.getState().setMediaAudioPaths(m.id, null, null))
        .finally(() => audioProbePending.current.delete(m.id))
    }
  }, [media, timelineClips])

  // Proxy de edição: pede uma cópia 720p com keyframe curto para cada vídeo
  // importado (usada só no preview — o export sempre lê o original).
  const proxyPending = useRef(new Set<string>())
  useEffect(() => {
    for (const m of media) {
      if (m.type !== 'video') continue
      const key = `${m.id}|${m.path}`
      if (proxyPending.current.has(key)) continue
      proxyPending.current.add(key)
      window.api
        .proxyEnsure(m.id, m.path)
        .then((res) => {
          if (res.status === 'ready') {
            if (res.path !== m.editProxyPath) useEditor.getState().setMediaEditProxy(m.id, res.path)
          } else if (m.editProxyPath) {
            useEditor.getState().setMediaEditProxy(m.id, null)
          }
        })
        // Sem proxy o preview só fica como era antes (lê o original) — nunca
        // um motivo para derrubar o app. Tira da lista para tentar de novo
        // na próxima mudança de mídia.
        .catch(() => proxyPending.current.delete(key))
    }
  }, [media])

  const proxiesPendentes = useRef<{ mediaId: string; src: string; path: string | null }[]>([])
  const aplicaProxy = (mediaId: string, src: string, path: string | null): void => {
    const m = useEditor.getState().media.find((x) => x.id === mediaId)
    if (m && m.path === src) useEditor.getState().setMediaEditProxy(mediaId, path)
  }
  const isPlayingNow = useEditor((s) => s.isPlaying)
  useEffect(() => {
    // o main pausa a fila de proxies enquanto toca; ao pausar, aplica o que ficou esperando
    window.api.proxyPlaying(isPlayingNow)
    if (!isPlayingNow) {
      const fila = proxiesPendentes.current.splice(0)
      for (const p of fila) aplicaProxy(p.mediaId, p.src, p.path)
    }
  }, [isPlayingNow])

  useEffect(() => {
    const removeProgress = window.api.onProxyProgress(({ mediaId, pct }) => {
      useEditor.getState().setProxyProgress(mediaId, pct)
    })
    const removeDone = window.api.onProxyDone(({ mediaId, src, path }) => {
      // Trocar o src de um <video> dispara load() nativo e bloqueia a thread
      // (apareceu no perfil de travada: `load` dentro do commit do React).
      // Durante o play, guarda e aplica quando o usuário pausar.
      if (useEditor.getState().isPlaying) proxiesPendentes.current.push({ mediaId, src, path })
      else aplicaProxy(mediaId, src, path)
      useEditor.getState().setProxyProgress(mediaId, null)
    })
    return () => {
      removeProgress()
      removeDone()
    }
  }, [])

  useEffect(() => {
    media.forEach((m) => {
      // Audio always; video too (feeds the audio meter) when short enough to
      // decode in memory (~10 min cap).
      const wantsPeaks = m.type === 'audio' || (m.type === 'video' && m.hasAudio && m.duration <= 600)
      const audioReady = m.type !== 'video' || m.audioPath !== undefined
      if (!wantsPeaks || !audioReady || m.peaks || peakPending.current.has(m.id)) return
      peakPending.current.add(m.id)
      peakQueue.current = peakQueue.current
        .then(() => window.api.mediaPeaks(m.audioPath || m.path))
        .then((peaks) => useEditor.getState().setPeaks(m.id, peaks))
        .catch(() => {})
        .finally(() => peakPending.current.delete(m.id))
    })
  }, [media])

  // Live-reload when Claude (via the MCP server) edits the project file.
  useEffect(() => {
    return window.api.onProjectExternalChange((data) => {
      if (data) {
        useEditor.getState().loadProject(data as ProjectData, true)
        setExternalEditApplied(true)
        setSaveStatus('saved')
      }
    })
  }, [])

  // Debounced autosave whenever the project changes.
  const dirty = useEditor((s) => s.dirty)
  useEffect(() => {
    if (!dirty) return
    let cancelled = false
    let timer: number | undefined

    const schedule = (delay: number): void => {
      timer = window.setTimeout(runSave, delay)
    }

    async function runSave(): Promise<void> {
      if (cancelled) return
      const data = useEditor.getState().serialize()
      const serialized = JSON.stringify(data)
      setSaveStatus('saving')
      setSaveError('')
      try {
        const result = await window.api.autosaveWrite(data)
        if (cancelled) return
        if (!result.ok) throw new Error(result.error || 'Falha ao salvar o projeto.')
        if (JSON.stringify(useEditor.getState().serialize()) === serialized) {
          useEditor.getState().markClean()
          setSaveStatus('saved')
        } else {
          schedule(1200)
        }
      } catch (error) {
        if (cancelled) return
        setSaveStatus('error')
        setSaveError(error instanceof Error ? error.message : String(error))
        schedule(5000)
      }
    }

    schedule(1200)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [dirty])

  return (
    <div className="app">
      <Toolbar
        saveStatus={saveStatus}
        saveError={saveError}
        focus={focus}
        onToggleFocus={() => setFocus((f) => !f)}
        onLibTabChange={setLibTab}
        onRequestInspectorTab={(tab) => setInspectorTabRequest({ tab, nonce: Date.now() })}
        onOpenSettings={() => setShowSettings(true)}
        onExport={() => setShowExport(true)}
        onOpenSessions={() => setShowSessions(true)}
        onOpenRecord={() => setShowRecord(true)}
      />
      {externalEditApplied && (
        <div className="codex-change-banner">
          <span>Alteração do Codex aplicada.</span>
          <button
            onClick={() => {
              undo()
              setExternalEditApplied(false)
            }}
          >
            Desfazer
          </button>
          <button className="codex-change-close" onClick={() => setExternalEditApplied(false)} title="Fechar">
            ×
          </button>
        </div>
      )}
      <div className="body">
        {!focus && (
          <div className="left-panel">
            <LibraryPanel tab={libTab} onTabChange={setLibTab} onNeedKeys={() => setShowSettings(true)} />
          </div>
        )}

        <div className="center-panel">
          <Preview />
        </div>

        {!focus && (
          <div className="right-panel">
            <Inspector requestTab={inspectorTabRequest} />
          </div>
        )}
      </div>

      <Timeline />

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {showExport && <ExportModal onClose={() => setShowExport(false)} />}
      {showSessions && <SessionsModal onClose={() => setShowSessions(false)} />}
      {showRecord && <RecordPanel onClose={() => setShowRecord(false)} />}
    </div>
  )
}
