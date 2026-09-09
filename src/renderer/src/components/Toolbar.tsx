import { useEffect, useState } from 'react'
import { nanoid } from 'nanoid'
import { useEditor } from '../store'
import type { ProjectData } from '../types'
import type { LibTab } from './LibraryPanel'
import type { InspTab } from './Inspector'

const MENU_ITEMS = ['Arquivo', 'Editar', 'Ver', 'Janela', 'Ajuda']

// Segmented "mode" control in the main toolbar. The real audio/color tools
// are per-clip, in the Inspector on the right — not something to browse in
// the library — so Cor/Áudio jump the INSPECTOR to the matching tab (and Cor
// also jumps the library to its look presets), rather than just moving the
// library like Editar does. Importar isn't a mode at all: it fires the
// import dialog once and leaves the highlighted mode wherever it was.
const MODES: Array<{
  id: 'cor' | 'audio' | 'importar'
  label: string
  jumpsLibTo?: LibTab
  jumpsInspectorTo?: InspTab
}> = [
  { id: 'cor', label: 'Cor', jumpsLibTo: 'efeitos', jumpsInspectorTo: 'ajustar' },
  { id: 'audio', label: 'Áudio', jumpsInspectorTo: 'audio' },
  { id: 'importar', label: 'Importar' }
]

export function Toolbar({
  saveStatus,
  saveError,
  focus,
  onToggleFocus,
  onLibTabChange,
  onRequestInspectorTab,
  onOpenSettings,
  onExport,
  onOpenSessions,
  onOpenRecord
}: {
  saveStatus: 'idle' | 'saving' | 'saved' | 'error'
  saveError: string
  focus: boolean
  onToggleFocus: () => void
  onLibTabChange: (t: LibTab) => void
  onRequestInspectorTab: (t: InspTab) => void
  onOpenSettings: () => void
  onExport: () => void
  onOpenSessions: () => void
  onOpenRecord: () => void
}): JSX.Element {
  const addMedia = useEditor((s) => s.addMedia)
  const clips = useEditor((s) => s.clips)
  const undo = useEditor((s) => s.undo)
  const redo = useEditor((s) => s.redo)
  const past = useEditor((s) => s._past.length)
  const future = useEditor((s) => s._future.length)
  // No "default" mode anymore now that Editar is gone — Cor/Áudio only light
  // up once you've actually jumped to one, Importar never lights up (it's an
  // action, not a mode).
  const [mode, setMode] = useState<'cor' | 'audio' | null>(null)

  // Importing a long video runs ffmpeg audio extraction for minutes. Without a
  // signal the app looked frozen — show which file, which stage, and how far.
  const [imp, setImp] = useState<{ name: string; pct: number; stage: string; i: number; n: number } | null>(null)
  useEffect(
    () =>
      window.api.onImportProgress((p) => {
        setImp((cur) => (cur ? { ...cur, pct: p.pct, stage: p.stage } : cur))
      }),
    []
  )

  async function importMedia(): Promise<void> {
    const paths = await window.api.openFiles()
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i]
      setImp({ name: path.split(/[\/]/).pop() || path, pct: 0, stage: 'lendo…', i: i + 1, n: paths.length })
      let meta: Awaited<ReturnType<typeof window.api.probe>>
      try {
        meta = await window.api.probe(path)
      } catch (e) {
        setImp(null)
        alert(`Falha ao importar "${path.split(/[\/]/).pop()}":
${(e as Error).message}`)
        continue
      }
      addMedia({
        id: nanoid(8),
        name: path.split(/[\\/]/).pop() || path,
        path,
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
    }
    setImp(null)
  }

  function selectMode(id: (typeof MODES)[number]['id']): void {
    if (id === 'importar') {
      void importMedia()
      return
    }
    setMode(id)
    const m = MODES.find((mm) => mm.id === id)
    if (m?.jumpsLibTo) onLibTabChange(m.jumpsLibTo)
    if (m?.jumpsInspectorTo) onRequestInspectorTab(m.jumpsInspectorTo)
  }

  async function save(): Promise<void> {
    const path = await window.api.saveProject(useEditor.getState().serialize())
    if (path) useEditor.getState().markClean()
  }

  async function open(): Promise<void> {
    const data = (await window.api.openProject()) as ProjectData | null
    if (data) useEditor.getState().loadProject(data)
  }

  function newProject(): void {
    if (clips.length > 0 && !confirm('Começar um novo projeto? As alterações não salvas serão perdidas.')) return
    useEditor.getState().newProject()
  }

  return (
    <div className="toolbar-wrap">
      <div className="menu-row">
        {MENU_ITEMS.map((m) => (
          <span key={m}>{m}</span>
        ))}
      </div>
      <div className="toolbar">
        <div className="brand">
          <span className="brand-mark" />
          Video Editor
        </div>

        <div className="tb-div" />
        <div className="mode-tabs">
          {MODES.map((m) => (
            <button
              key={m.id}
              className={mode === m.id ? 'mode-tab on' : 'mode-tab'}
              onClick={() => selectMode(m.id)}
              disabled={m.id === 'importar' && !!imp}
            >
              {m.id === 'importar' && <span className="mode-tab-plus">＋</span>}
              {m.label}
            </button>
          ))}
        </div>

        {imp && (
          <span className="import-status" title={imp.name}>
            <span className="import-label">
              {imp.n > 1 ? `(${imp.i}/${imp.n}) ` : ''}
              {imp.name.length > 22 ? imp.name.slice(0, 22) + '…' : imp.name} · {imp.stage} ·{' '}
              {Math.round(imp.pct * 100)}%
            </span>
            <span className="import-bar">
              <span className="import-fill" style={{ width: `${Math.round(imp.pct * 100)}%` }} />
            </span>
          </span>
        )}

        <div style={{ flex: 1 }} />

        {saveStatus !== 'idle' && (
          <span className={`save-status-inline ${saveStatus}`} title={saveError}>
            {saveStatus === 'saving' ? 'Salvando…' : saveStatus === 'saved' ? 'Salvo' : 'Erro ao salvar'}
          </span>
        )}
        <div className="tb-div" />

        <button className="btn-mini" onClick={newProject} title="Novo projeto">
          Novo
        </button>
        <button className="btn-mini" onClick={open} title="Abrir projeto">
          Abrir
        </button>
        <button className="btn-mini" onClick={save} title="Salvar projeto (Ctrl+S)">
          Salvar
        </button>
        <button className="btn-mini" onClick={onOpenSessions} title="Salvar/retomar sessões">
          Sessões
        </button>
        <button className="btn-mini icon" onClick={undo} disabled={past === 0} title="Desfazer (Ctrl+Z)">
          ↶
        </button>
        <button className="btn-mini icon" onClick={redo} disabled={future === 0} title="Refazer (Ctrl+Y)">
          ↷
        </button>

        <div className="tb-div" />
        <button className={focus ? 'tb-toggle on' : 'tb-toggle'} onClick={onToggleFocus} title="Esconder painéis (tela cheia do vídeo)">
          ⛶ Foco
        </button>
        <button className="btn-mini" onClick={onOpenRecord} title="Gravar da webcam / tela">
          🎥 Gravar
        </button>
        <button className="btn-mini icon" onClick={onOpenSettings} title="Configurações">
          ⚙
        </button>
        <button className="btn btn-primary" onClick={onExport} disabled={clips.length === 0}>
          ⬆ Exportar
        </button>
      </div>
    </div>
  )
}
