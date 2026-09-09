import { useEffect, useState } from 'react'
import { useEditor } from '../store'
import type { ProjectData } from '../types'

interface SessionInfo {
  name: string
  file: string
  mtime: number
}

interface SnapshotInfo {
  file: string
  name: string
  mtime: number
  clips: number
}

export function SessionsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([])
  const [name, setName] = useState('')
  const [msg, setMsg] = useState('')

  async function refresh(): Promise<void> {
    setSessions(await window.api.sessionList())
    setSnapshots(await window.api.snapshotList())
  }
  useEffect(() => {
    refresh()
  }, [])

  async function restoreSnapshot(s: SnapshotInfo): Promise<void> {
    if (
      useEditor.getState().clips.length > 0 &&
      !confirm(
        `Voltar para o backup de ${new Date(s.mtime).toLocaleString()} (${s.clips} clipes)?\n\n` +
          'O projeto aberto agora será substituído.'
      )
    )
      return
    const data = (await window.api.snapshotLoad(s.file)) as ProjectData | null
    if (data) {
      useEditor.getState().loadProject(data)
      onClose()
    } else {
      setMsg('Não consegui ler esse backup.')
    }
  }

  async function save(): Promise<void> {
    const nm = name.trim()
    if (!nm) {
      setMsg('Dê um nome para a sessão.')
      return
    }
    const res = await window.api.sessionSave(nm, useEditor.getState().serialize())
    if (res.ok) {
      setMsg(`Sessão "${nm}" salva ✓`)
      useEditor.getState().markClean()
      setName('')
      refresh()
    } else {
      setMsg(res.error || 'Falha ao salvar.')
    }
  }

  async function load(s: SessionInfo): Promise<void> {
    if (useEditor.getState().clips.length > 0 && !confirm(`Abrir "${s.name}"? As alterações não salvas serão perdidas.`))
      return
    const data = (await window.api.sessionLoad(s.file)) as ProjectData | null
    if (data) {
      useEditor.getState().loadProject(data)
      onClose()
    } else {
      setMsg('Não consegui abrir essa sessão.')
    }
  }

  async function del(s: SessionInfo): Promise<void> {
    if (!confirm(`Apagar a sessão "${s.name}"? Isso não pode ser desfeito.`)) return
    await window.api.sessionDelete(s.file)
    refresh()
  }

  const fmtDate = (ms: number): string => {
    const d = new Date(ms)
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>🗂 Sessões</h2>
        <p className="hint">Salve o estado atual do projeto com um nome e retome quando quiser.</p>

        <div className="session-save-row">
          <input
            placeholder="Nome da sessão (ex: HermesWeb v2)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
          <button className="btn btn-primary" onClick={save}>
            💾 Salvar sessão
          </button>
        </div>

        <div className="session-list">
          {sessions.length === 0 ? (
            <p className="hint">Nenhuma sessão salva ainda.</p>
          ) : (
            sessions.map((s) => (
              <div key={s.file} className="session-row">
                <div className="session-meta">
                  <div className="session-name">{s.name}</div>
                  <div className="session-date">{fmtDate(s.mtime)}</div>
                </div>
                <div className="session-actions">
                  <button className="btn" onClick={() => load(s)}>
                    Abrir
                  </button>
                  <button className="btn icon" title="Apagar" onClick={() => del(s)}>
                    🗑
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="settings-section">🕘 Backups automáticos</div>
        <p className="hint" style={{ marginTop: -4 }}>
          O app guarda o projeto sozinho a cada 5 minutos. Use isto se perder trabalho.
        </p>
        <div className="session-list">
          {snapshots.length === 0 ? (
            <p className="hint">Nenhum backup ainda — eles começam a aparecer conforme você edita.</p>
          ) : (
            snapshots.map((s) => (
              <div key={s.file} className="session-row">
                <div className="session-meta">
                  <div className="session-name">{fmtDate(s.mtime)}</div>
                  <div className="session-date">{s.clips} clipes</div>
                </div>
                <div className="session-actions">
                  <button className="btn" onClick={() => restoreSnapshot(s)}>
                    Restaurar
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {msg && <div className="saved-tag">{msg}</div>}
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  )
}
