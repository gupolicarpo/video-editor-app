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
import { computePeaks } from './mediaTools'
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
    const beat = (now: number): void => {
      const gap = now - last
      if (gap > 300) {
        const st = useEditor.getState()
        void window.api.perfLog(
          `stall ${Math.round(gap)}ms | playing=${st.isPlaying} playhead=${st.playhead.toFixed(1)} clips=${st.clips.length} media=${st.media.length}`
        )
      }
      last = now
      raf = requestAnimationFrame(beat)
    }
    raf = requestAnimationFrame(beat)
    return () => cancelAnimationFrame(raf)
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

  useEffect(() => {
    media.forEach((m) => {
      // Audio always; video too (feeds the audio meter) when short enough to
      // decode in memory (~10 min cap).
      const wantsPeaks = m.type === 'audio' || (m.type === 'video' && m.hasAudio && m.duration <= 600)
      const audioReady = m.type !== 'video' || m.audioPath !== undefined
      if (!wantsPeaks || !audioReady || m.peaks || peakPending.current.has(m.id)) return
      peakPending.current.add(m.id)
      peakQueue.current = peakQueue.current
        .then(() => computePeaks(m.audioPath || m.path))
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
