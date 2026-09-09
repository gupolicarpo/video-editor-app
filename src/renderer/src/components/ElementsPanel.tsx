import { useEffect, useState } from 'react'
import { nanoid } from 'nanoid'
import { useEditor } from '../store'
import type { MediaItem } from '../types'

type LibraryItem = {
  id: string
  name: string
  path: string
  type: 'image'
  width: number
  height: number
  prompt?: string
  source: 'ai' | 'upload'
  createdAt: number
}

// Windows path comparison, done here (no Node `path` module in the renderer):
// same fix as the main-process library module — `/`-vs-`\` and case must not
// make the same file look like two different ones.
const normPath = (p: string): string => p.toLowerCase().replace(/\//g, '\\')

const IDEIAS = [
  'seta apontando para a direita, estilo neon roxo',
  'balão de fala vazio, contorno branco grosso',
  'ícone de foguete decolando, flat design',
  'coroa dourada brilhante',
  'selo circular "NOVO" em vermelho'
]

/**
 * Overlay elements: bring your own PNGs or ask for one.
 *
 * The grid here reads from a personal library that lives outside any single
 * project (main/library.ts, an index next to `generated/elements` in
 * userData) — not from this project's `media` array. An element used to only
 * exist as long as this project's media list held onto it: switch projects,
 * or hit "Limpar não usada" in Mídia, and it vanished from every screen even
 * though the PNG was still sitting on disk. Placing one onto the timeline
 * still registers it into the CURRENT project's media (that's how a clip
 * references a file), but removing it from that project no longer removes it
 * from here.
 */
export function ElementsPanel({ search = '' }: { search?: string }): JSX.Element {
  const media = useEditor((s) => s.media)
  const tracks = useEditor((s) => s.tracks)
  const clips = useEditor((s) => s.clips)
  const addMedia = useEditor((s) => s.addMedia)
  const addClip = useEditor((s) => s.addClip)
  const addTrack = useEditor((s) => s.addTrack)

  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [library, setLibrary] = useState<LibraryItem[]>([])
  const [scanning, setScanning] = useState(false)
  const [scanMsg, setScanMsg] = useState('')

  const refreshLibrary = (): void => {
    void window.api.libraryList().then(setLibrary)
  }
  useEffect(refreshLibrary, [])

  // One-time recovery for elements generated before this library existed —
  // the files were never deleted, just never indexed.
  async function scanOrphans(): Promise<void> {
    setScanning(true)
    setScanMsg('')
    try {
      const { imported } = await window.api.libraryScanOrphans()
      setScanMsg(imported > 0 ? `✓ ${imported} elemento(s) recuperado(s).` : 'Nada perdido por aí — tudo já catalogado.')
      if (imported > 0) refreshLibrary()
    } finally {
      setScanning(false)
    }
  }

  // Elements always go OVER the footage: reuse the topmost free video track at
  // the playhead, only creating a new one when that spot is taken.
  function place(m: MediaItem): void {
    const playhead = useEditor.getState().playhead
    const dur = 5
    const videoTracks = tracks.filter((t) => t.kind === 'video')
    const free = videoTracks.find(
      (t) =>
        !clips.some(
          (c) => c.trackId === t.id && c.start < playhead + dur && c.start + c.duration > playhead
        )
    )
    if (free) {
      addClip(m.id, free.id, playhead)
      return
    }
    addTrack('video')
    const top = useEditor.getState().tracks.find((t) => t.kind === 'video')
    if (top) addClip(m.id, top.id, playhead)
  }

  async function register(path: string): Promise<MediaItem | null> {
    const meta = await window.api.probe(path)
    const item: MediaItem = {
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
    }
    addMedia(item)
    return item
  }

  // Place a library item into THIS project: reuse the media entry if this
  // project already registered that path (e.g. placed before), else register
  // it fresh, then drop a clip on the timeline.
  async function placeLibraryItem(item: LibraryItem): Promise<void> {
    const existing = media.find((m) => normPath(m.path) === normPath(item.path))
    const m = existing || (await register(item.path))
    if (m) place(m)
  }

  async function upload(): Promise<void> {
    setErr('')
    const paths = await window.api.openFiles()
    for (const p of paths) {
      if (!/\.(png|jpg|jpeg|webp|gif)$/i.test(p)) continue
      const item = await register(p)
      if (item) {
        await window.api.libraryAdd({
          name: item.name,
          path: item.path,
          type: 'image',
          width: item.width,
          height: item.height,
          source: 'upload'
        })
      }
    }
    refreshLibrary()
  }

  async function generate(): Promise<void> {
    if (!prompt.trim()) return
    setErr('')
    setBusy(true)
    try {
      const res = await window.api.generateElement({ prompt })
      if (!res.ok || !res.path) {
        setErr(res.error || 'Falhou ao gerar.')
        return
      }
      const item = await register(res.path)
      if (item) {
        await window.api.libraryAdd({
          name: item.name,
          path: item.path,
          type: 'image',
          width: item.width,
          height: item.height,
          prompt,
          source: 'ai'
        })
        refreshLibrary()
        place(item)
      }
      setPrompt('')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function removeFromLibrary(item: LibraryItem): Promise<void> {
    const usedHere = media.some((m) => normPath(m.path) === normPath(item.path))
    const warn = usedHere
      ? `"${item.name}" está em uso no projeto atual. Remover da biblioteca apaga o arquivo e o clipe vai parar de tocar. Continuar?`
      : `Remover "${item.name}" da biblioteca? Isso apaga o arquivo do disco — não dá pra desfazer.`
    if (!confirm(warn)) return
    await window.api.libraryRemove(item.id, true)
    refreshLibrary()
  }

  return (
    <>
      <button className="btn full" onClick={upload} style={{ marginTop: 0 }}>
        ⬆ Enviar meus elementos (PNG)
      </button>
      <p className="hint">PNG com fundo transparente funciona melhor sobre o vídeo.</p>

      <div className="insp-section">✨ Gerar elemento com IA</div>
      <label className="field">
        <textarea
          rows={2}
          value={prompt}
          placeholder="ex: seta curva apontando para baixo, estilo neon roxo"
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      <div className="chip-row">
        {IDEIAS.map((i) => (
          <button key={i} className="chip" onClick={() => setPrompt(i)} title={i}>
            {i.split(',')[0]}
          </button>
        ))}
      </div>
      <button className="btn btn-primary full" onClick={generate} disabled={busy || !prompt.trim()}>
        {busy ? '⏳ Gerando…' : '✨ Gerar elemento'}
      </button>
      {err && <p className="ai-error">{err}</p>}
      <p className="hint">
        Sai como PNG com fundo transparente (OpenAI) e já entra na timeline por cima do vídeo. Dê
        forma e movimento no Inspetor: máscara, entrada/loop/saída.
      </p>

      <div className="insp-section">🧩 Minha biblioteca ({library.length})</div>
      <p className="hint" style={{ marginTop: -4 }}>
        Fica salva aqui pra sempre, em qualquer projeto — mesmo que você limpe a mídia não usada
        deste projeto ou abra outro.
      </p>
      <button className="btn-mini full-mini" onClick={() => void scanOrphans()} disabled={scanning}>
        {scanning ? '🔍 Procurando…' : '🔍 Recuperar elementos gerados antes desta biblioteca existir'}
      </button>
      {scanMsg && <p className="hint">{scanMsg}</p>}
      {(() => {
        const q = search.trim().toLowerCase()
        const filtered = q
          ? library.filter(
              (item) => item.name.toLowerCase().includes(q) || (item.prompt || '').toLowerCase().includes(q)
            )
          : library
        if (library.length === 0) return <p className="hint">Nenhum ainda — envie um PNG ou gere um acima.</p>
        if (filtered.length === 0) return <p className="hint">Nada bate com "{search}".</p>
        return (
        <div className="media-grid">
          {filtered.map((item) => (
            <div key={item.id} className="media-card compact" title={item.prompt || item.name}>
              <div className="media-thumb">
                <img src={window.api.mediaUrl(item.path)} alt={item.name} draggable={false} />
                {item.source === 'ai' && <span className="media-badge">✨ IA</span>}
                <div className="media-hover">
                  <button
                    className="btn-mini"
                    title="Colocar sobre o vídeo"
                    onClick={() => void placeLibraryItem(item)}
                  >
                    ＋
                  </button>
                  <button
                    className="btn-mini ghost"
                    title="Remover da biblioteca (apaga o arquivo)"
                    onClick={() => void removeFromLibrary(item)}
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div className="media-name">{item.name}</div>
            </div>
          ))}
        </div>
        )
      })()}
    </>
  )
}
