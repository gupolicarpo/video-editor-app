import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

// Windows paths compare unreliably as raw strings — `/`-vs-`\`-joined paths to
// the same file, or differing case, are the same file to the filesystem but
// not to `===`. Every path comparison in this module goes through this first
// (verified: without it, an already-tracked file built with a differently-
// slashed path silently reappeared as an "orphan" on every scan).
const norm = (p: string): string => resolve(p).toLowerCase()

/**
 * A personal "Elements" library, independent of any single project.
 *
 * The gap this closes: an AI-generated element used to live only in the
 * CURRENT project's `media` array. Start a new project, open a different one,
 * or hit "Limpar não usada" (which drops any media no clip references) and
 * the entry vanished from every screen — even though the PNG was still sitting
 * on disk under generated/elements. The file was never actually lost, just
 * unreachable. This gives that folder an index that survives all of that,
 * the way FlexClip's Elements tab is account-wide rather than per-timeline.
 */

export interface LibraryItem {
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

function libraryPath(userDataDir: string): string {
  return join(userDataDir, 'library', 'elements.json')
}

function readAll(userDataDir: string): LibraryItem[] {
  const p = libraryPath(userDataDir)
  if (!existsSync(p)) return []
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // A corrupt index must not take the user's element files down with it —
    // they are still on disk; only the catalog of them would need rebuilding.
    return []
  }
}

function writeAll(userDataDir: string, items: LibraryItem[]): void {
  const p = libraryPath(userDataDir)
  mkdirSync(join(userDataDir, 'library'), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf-8')
  renameSync(tmp, p)
}

export function listLibraryElements(userDataDir: string): LibraryItem[] {
  return readAll(userDataDir).sort((a, b) => b.createdAt - a.createdAt)
}

export function addLibraryElement(
  userDataDir: string,
  item: Omit<LibraryItem, 'id' | 'createdAt'> & { id?: string; createdAt?: number }
): LibraryItem {
  const items = readAll(userDataDir)
  // The same file re-added (e.g. re-uploading, or a cache hit) updates the
  // existing row instead of piling up duplicates.
  const existing = items.find((i) => norm(i.path) === norm(item.path))
  const full: LibraryItem = {
    id: existing?.id || item.id || `el_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: item.name,
    path: item.path,
    type: 'image',
    width: item.width,
    height: item.height,
    prompt: item.prompt,
    source: item.source,
    createdAt: existing?.createdAt || item.createdAt || Date.now()
  }
  const next = existing ? items.map((i) => (norm(i.path) === norm(item.path) ? full : i)) : [...items, full]
  writeAll(userDataDir, next)
  return full
}

/**
 * Elements generated before this library existed are real files sitting in
 * generated/elements with no index entry — orphaned, not lost. List the ones
 * the index doesn't know about yet so the caller can probe and import them.
 */
export function findOrphanedElementFiles(userDataDir: string): string[] {
  const dir = join(userDataDir, 'generated', 'elements')
  if (!existsSync(dir)) return []
  const known = new Set(readAll(userDataDir).map((i) => norm(i.path)))
  return readdirSync(dir)
    .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .map((f) => join(dir, f))
    .filter((p) => !known.has(norm(p)))
}

export function removeLibraryElement(userDataDir: string, id: string, deleteFile: boolean): boolean {
  const items = readAll(userDataDir)
  const item = items.find((i) => i.id === id)
  if (!item) return false
  writeAll(userDataDir, items.filter((i) => i.id !== id))
  if (deleteFile) {
    try {
      unlinkSync(item.path)
    } catch {
      /* file already gone, or in use — the index entry is removed either way */
    }
  }
  return true
}
