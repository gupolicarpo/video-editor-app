import { app, dialog, BrowserWindow } from 'electron'
import { join, dirname, basename, resolve, sep } from 'path'
import { copyFileSync, readFileSync, writeFileSync, existsSync, watch, mkdirSync, readdirSync, statSync, unlinkSync, renameSync } from 'fs'

// Write JSON atomically: write to a temp file, then rename over the target.
// A crash mid-write can no longer leave a truncated/corrupt project file.
function writeFileAtomic(path: string, contents: string, keepBackup = false): void {
  const tmp = `${path}.${process.pid}.tmp`
  if (keepBackup && existsSync(path)) copyFileSync(path, `${path}.bak`)
  writeFileSync(tmp, contents, 'utf-8')
  renameSync(tmp, path)
}

function autosavePath(): string {
  return join(app.getPath('userData'), 'autosave.vedit.json')
}

// Track what WE last wrote so the watcher can tell our own saves from
// external ones (e.g. the MCP server editing the project).
let lastWritten = ''

export async function saveProjectDialog(win: BrowserWindow, data: unknown): Promise<string | null> {
  const res = await dialog.showSaveDialog(win, {
    title: 'Salvar projeto',
    defaultPath: 'projeto.vedit.json',
    filters: [{ name: 'Projeto Video Editor', extensions: ['vedit.json', 'json'] }]
  })
  if (res.canceled || !res.filePath) return null
  writeFileAtomic(res.filePath, JSON.stringify(data, null, 2), true)
  return res.filePath
}

export async function openProjectDialog(win: BrowserWindow): Promise<unknown | null> {
  const res = await dialog.showOpenDialog(win, {
    title: 'Abrir projeto',
    properties: ['openFile'],
    filters: [{ name: 'Projeto Video Editor', extensions: ['vedit.json', 'json'] }]
  })
  if (res.canceled || res.filePaths.length === 0) return null
  return JSON.parse(readFileSync(res.filePaths[0], 'utf-8'))
}

export interface AutosaveResult {
  ok: boolean
  error?: string
}

// Rolling timestamped snapshots, kept alongside the single .bak the atomic
// write already leaves behind. One .bak only ever holds the state from the
// PREVIOUS save, so a project that gets emptied and then autosaved twice is
// unrecoverable — which is exactly how an afternoon of edits was lost once.
// These snapshots trade a few hundred KB for being able to go back hours.
const SNAPSHOT_EVERY_MS = 5 * 60 * 1000
const SNAPSHOT_KEEP = 40
let lastSnapshotAt = 0

function snapshotDir(): string {
  const d = join(app.getPath('userData'), 'project-backups')
  mkdirSync(d, { recursive: true })
  return d
}

function writeSnapshot(contents: string, clipCount: number): void {
  // Never let an empty/near-empty project evict real history: a snapshot of
  // nothing has no recovery value, and writing it would push a good one out.
  if (clipCount === 0) return
  const now = Date.now()
  if (now - lastSnapshotAt < SNAPSHOT_EVERY_MS) return
  lastSnapshotAt = now
  try {
    const dir = snapshotDir()
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)
    writeFileSync(join(dir, `autosave_${stamp}.vedit.json`), contents, 'utf-8')
    const old = readdirSync(dir)
      .filter((f) => f.startsWith('autosave_') && f.endsWith('.vedit.json'))
      .sort()
      .slice(0, -SNAPSHOT_KEEP)
    for (const f of old) {
      try {
        unlinkSync(join(dir, f))
      } catch {
        /* best-effort pruning */
      }
    }
  } catch {
    /* snapshots are a safety net, never a reason to fail the save */
  }
}

export function writeAutosave(data: unknown): AutosaveResult {
  try {
    const s = JSON.stringify(data)
    lastWritten = s
    writeFileAtomic(autosavePath(), s, true)
    const clips = (data as { clips?: unknown[] })?.clips
    writeSnapshot(s, Array.isArray(clips) ? clips.length : 0)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export interface ProjectSnapshot {
  file: string
  name: string
  mtime: number
  clips: number
}

export function listSnapshots(): ProjectSnapshot[] {
  try {
    const dir = snapshotDir()
    return readdirSync(dir)
      .filter((f) => f.startsWith('autosave_') && f.endsWith('.vedit.json'))
      .map((f) => {
        const full = join(dir, f)
        let clips = 0
        try {
          clips = (JSON.parse(readFileSync(full, 'utf-8')).clips || []).length
        } catch {
          /* unreadable snapshot still gets listed, just without a count */
        }
        return { file: full, name: f, mtime: statSync(full).mtimeMs, clips }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}

export function loadSnapshot(file: string): unknown | null {
  const root = resolve(snapshotDir())
  const candidate = resolve(file)
  if (!candidate.startsWith(`${root}${sep}`)) return null
  try {
    return JSON.parse(readFileSync(candidate, 'utf-8'))
  } catch {
    return null
  }
}

export function readAutosave(): unknown | null {
  const primary = autosavePath()
  for (const candidate of [primary, `${primary}.bak`]) {
    try {
      if (existsSync(candidate)) {
        const s = readFileSync(candidate, 'utf-8')
        const data = JSON.parse(s)
        if (candidate !== primary) writeFileAtomic(primary, s)
        lastWritten = s
        return data
      }
    } catch {
      /* try the backup */
    }
  }
  return null
}

// ---- Named sessions (save / resume) ----
function sessionsDir(): string {
  const d = join(app.getPath('userData'), 'sessions')
  mkdirSync(d, { recursive: true })
  return d
}
function safeName(name: string): string {
  return (name || '').replace(/[^a-zA-Z0-9 _\-À-ÿ]/g, '').trim().slice(0, 60) || 'sessao'
}

export interface SessionInfo {
  name: string
  file: string
  mtime: number
}

export function saveSession(name: string, data: unknown): { ok: boolean; file?: string; error?: string } {
  try {
    const file = join(sessionsDir(), safeName(name) + '.vedit.json')
    writeFileAtomic(file, JSON.stringify(data, null, 2))
    return { ok: true, file }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

export function listSessions(): SessionInfo[] {
  try {
    return readdirSync(sessionsDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const file = join(sessionsDir(), f)
        return { name: f.replace(/\.vedit\.json$|\.json$/, ''), file, mtime: statSync(file).mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}

export function loadSession(file: string): unknown | null {
  const root = resolve(sessionsDir())
  const candidate = resolve(file)
  if (!candidate.startsWith(`${root}${sep}`) || !candidate.endsWith('.json')) return null
  try {
    return JSON.parse(readFileSync(candidate, 'utf-8'))
  } catch {
    return null
  }
}

export function deleteSession(file: string): boolean {
  const root = resolve(sessionsDir())
  const candidate = resolve(file)
  if (!candidate.startsWith(`${root}${sep}`) || !candidate.endsWith('.json')) return false
  try {
    unlinkSync(candidate)
    return true
  } catch {
    return false
  }
}

// Watch the autosave file for EXTERNAL changes (the MCP server) and notify.
export function watchProjectFile(onExternalChange: (data: unknown) => void): void {
  const p = autosavePath()
  const name = basename(p)
  let timer: NodeJS.Timeout | null = null
  try {
    watch(dirname(p), (_evt, fname) => {
      if (fname && fname !== name) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        try {
          if (!existsSync(p)) return
          const s = readFileSync(p, 'utf-8')
          if (s && s !== lastWritten) {
            lastWritten = s
            onExternalChange(JSON.parse(s))
          }
        } catch {
          /* ignore */
        }
      }, 250)
    })
  } catch {
    /* directory watch unsupported; ignore */
  }
}
