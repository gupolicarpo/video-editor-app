import { app, shell, BrowserWindow, ipcMain, dialog, protocol, session, desktopCapturer } from 'electron'
import { extname, join, normalize, sep } from 'path'
import { createReadStream, statSync, existsSync, readdirSync } from 'fs'
import { Readable } from 'stream'
import { tmpdir } from 'os'
import { writeFileSync } from 'fs'
import {
  prepareMedia,
  renderTimeline,
  getFfmpegInfo,
  enhanceClip,
  applyLook,
  enhanceAudio,
  cancelRender,
  autoGradeClip
} from './ffmpeg'
import { loadSettings, saveSettings, saveSettingsReport, settingsFilePath } from './settings'
import { generateVideo, enhancePrompt } from './ai'
import { cancelSeedanceGeneration } from './ai/seedance'
import { lumaModify } from './ai/luma'
import { heygenGenerate } from './ai/heygen'
import { gapFill } from './ai/gapfill'
import { klingGenerate } from './ai/kling'
import { elevenIsolate, elevenBalance } from './ai/eleven'
import { generateElement } from './ai/elements'
import { remakeAnalyze, remakeRefine } from './ai/remake'
import { budgetState, budgetReserve, budgetReconcile, budgetCleanupStale } from './budget'
import { transcribeMedia, transcriptionAvailable, findDeadRanges, buildSrt, type Transcript } from './transcribe'
import {
  saveRecording,
  openRecordingStream,
  writeRecordingChunk,
  closeRecordingStream,
  abortRecordingStream
} from './record'
import { matteClip, matteAvailable } from './matte'
import { FX_CATALOG, renderFx } from './fx'
import {
  listLibraryElements,
  addLibraryElement,
  removeLibraryElement,
  findOrphanedElementFiles,
  type LibraryItem
} from './library'
import {
  saveProjectDialog,
  openProjectDialog,
  writeAutosave,
  readAutosave,
  watchProjectFile,
  saveSession,
  listSessions,
  loadSession,
  listSnapshots,
  loadSnapshot,
  deleteSession
} from './project'

// Register a privileged scheme so the renderer (served over http in dev) can
// load local media files. Streaming + bypassCSP let <video> issue range
// requests for smooth scrubbing.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true }
  }
])

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    backgroundColor: '#16161c',
    title: 'Video Editor',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      // Chromium freezes timers in a hidden/minimised window. A recording in
      // progress would stall its chunk timer and drop frames — measured, not
      // theoretical: a hidden test window captured 17fps instead of 30.
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---- media:// access control ----
// The protocol handler only serves files the app legitimately knows about:
// files picked by the user, media referenced by a loaded project, and anything
// inside the app's own dirs. Blocks path-traversal style reads of arbitrary files.
const allowedMediaPaths = new Set<string>()
const allowedMediaDirs = new Set<string>()

function normKey(p: string): string {
  return normalize(p).toLowerCase()
}
function allowMediaPath(p?: string | null): void {
  if (p) allowedMediaPaths.add(normKey(p))
}
function allowMediaDir(d?: string | null): void {
  if (d) allowedMediaDirs.add(normKey(d))
}
function allowProjectMedia(data: unknown): void {
  const media = (data as {
    media?: Array<{ path?: string; audioPath?: string | null; audioPaths?: string[] | null }>
  } | null)?.media
  if (Array.isArray(media)) {
    for (const m of media) {
      allowMediaPath(m?.path)
      allowMediaPath(m?.audioPath)
      for (const audioPath of m?.audioPaths || []) allowMediaPath(audioPath)
    }
  }
}
function isMediaAllowed(p: string): boolean {
  const key = normKey(p)
  if (allowedMediaPaths.has(key)) return true
  for (const d of allowedMediaDirs) {
    const prefix = d.endsWith(sep) ? d : `${d}${sep}`
    if (key === d || key.startsWith(prefix)) return true
  }
  return false
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}

// Stream a local file, honoring HTTP Range so <video> can seek smoothly.
function registerMediaProtocol(): void {
  protocol.handle('media', async (request) => {
    const url = new URL(request.url)
    const filePath = decodeURIComponent(url.searchParams.get('p') || '')
    if (!filePath) return new Response('missing path', { status: 400 })
    if (!isMediaAllowed(filePath)) return new Response('forbidden', { status: 403 })

    let size: number
    try {
      size = statSync(filePath).size
    } catch {
      return new Response('not found', { status: 404 })
    }

    const mime = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream'
    const rangeHeader = request.headers.get('Range')

    if (rangeHeader) {
      const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
      let start = match && match[1] ? parseInt(match[1], 10) : 0
      let end = match && match[2] ? parseInt(match[2], 10) : size - 1
      if (isNaN(start) || start < 0) start = 0
      if (isNaN(end) || end >= size) end = size - 1
      if (start > end) start = 0
      const body = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Type': mime,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1)
        }
      })
    }

    const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': mime, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
    })
  })
}

app.whenReady().then(() => {
  // App-owned dirs are always servable via media://.
  allowMediaDir(app.getPath('userData'))
  allowMediaDir(tmpdir())
  const s0 = loadSettings()
  if (s0.mediaDir) allowMediaDir(s0.mediaDir)

  // Camera and microphone for the recording panel. Electron denies these by
  // default, and `enumerateDevices` hides device *labels* until one is granted —
  // so without this the source picker shows three blank entries. Nothing else is
  // allowed: this is our own renderer, not remote content.
  const allowedPermissions = new Set(['media', 'audioCapture', 'videoCapture'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(allowedPermissions.has(permission))
  )
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    allowedPermissions.has(permission)
  )

  // Refund budget reservations orphaned by a crash.
  budgetCleanupStale()

  registerMediaProtocol()
  registerIpc()
  createWindow()

  // Live-reload when the MCP server (Claude) edits the project file.
  watchProjectFile((data) => {
    allowProjectMedia(data)
    mainWindow?.webContents.send('project:externalChange', data)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function registerIpc(): void {
  // Open file picker for media import.
  ipcMain.handle('dialog:openFiles', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: 'Importar mídia',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Mídia', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'png', 'jpg', 'jpeg', 'gif', 'webp'] },
        { name: 'Todos os arquivos', extensions: ['*'] }
      ]
    })
    if (res.canceled) return []
    for (const p of res.filePaths) allowMediaPath(p)
    return res.filePaths
  })

  // "Relocalizar": the user points at a folder (e.g. where they moved a drive's
  // contents) and every missing file whose BASENAME matches something found
  // there — anywhere under that folder — gets relinked. Matching by name
  // rather than asking file-by-file is what makes this worth a button: moving
  // a whole project folder breaks every path the same way, so fixing them one
  // at a time is the tedious case this exists to skip.
  ipcMain.handle('dialog:relocateMedia', async (_e, missingNames: string[]) => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: 'Escolher pasta onde os arquivos estão agora',
      properties: ['openDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return {}
    const root = res.filePaths[0]
    const wanted = new Set(missingNames)
    const found: Record<string, string> = {}
    const MAX_ENTRIES = 200_000 // guard against scanning an entire drive by accident
    let scanned = 0

    function walk(dir: string): void {
      if (Object.keys(found).length >= wanted.size) return
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const name of entries) {
        if (scanned++ > MAX_ENTRIES) return
        if (Object.keys(found).length >= wanted.size) return
        const full = join(dir, name)
        let stat
        try {
          stat = statSync(full)
        } catch {
          continue
        }
        if (stat.isDirectory()) {
          walk(full)
        } else if (wanted.has(name) && !(name in found)) {
          found[name] = full
          allowMediaPath(full)
        }
      }
    }
    walk(root)
    return found
  })

  // Probe metadata and combine every embedded audio track for Chromium preview.
  // Which media files vanished from disk (moved/renamed/deleted)?
  ipcMain.handle('media:checkMissing', async (_e, paths: string[]) =>
    (paths || []).filter((p) => !!p && !existsSync(p))
  )

  ipcMain.handle('media:probe', async (e, filePath: string) => {
    const meta = await prepareMedia(filePath, join(app.getPath('userData'), 'audio-cache'), (pct, stage) =>
      e.sender.send('import:progress', { path: filePath, pct, stage })
    )
    allowMediaPath(meta.audioPath)
    for (const audioPath of meta.audioPaths || []) allowMediaPath(audioPath)
    return meta
  })

  // Pick an output path for export.
  ipcMain.handle('dialog:saveFile', async (_e, defaultName: string) => {
    const res = await dialog.showSaveDialog(mainWindow!, {
      title: 'Exportar vídeo',
      defaultPath: defaultName || 'export.mp4',
      filters: [{ name: 'Vídeo MP4', extensions: ['mp4'] }]
    })
    return res.canceled ? null : res.filePath
  })

  // Render the timeline. Progress is streamed back over a channel.
  ipcMain.handle('export:render', async (e, payload) => {
    return renderTimeline(payload, (progress) => {
      e.sender.send('export:progress', progress)
    })
  })
  ipcMain.handle('export:cancel', async () => cancelRender())

  // Settings (API keys, prefs).
  ipcMain.handle('settings:get', async () => loadSettings())
  ipcMain.handle('settings:set', async (_e, patch) => {
    // Flight recorder for settings. A save that throws here used to reject the
    // IPC, and the renderer had no .catch() — so the UI sat on "auto-saves"
    // forever while an API key silently never reached disk. Log every attempt.
    const log = (line: string): void => {
      try {
        require('fs').appendFileSync(
          join(app.getPath('userData'), 'settings-debug.log'),
          `${new Date().toISOString()} ${line}
`
        )
      } catch {
        /* logging must never break saving */
      }
    }
    try {
      const keys = patch && typeof patch === 'object' ? Object.keys(patch) : []
      log(`set: recebido, ${keys.length} campos, elevenApiKey=${
        (patch as Record<string, unknown>)?.elevenApiKey ? 'preenchido' : 'vazio'
      }`)
      const report = saveSettingsReport(patch)
      log(`set: gravou ok=${report.ok} bytes=${report.wroteBytes ?? '-'} erro=${report.error ?? '-'} path=${report.path}`)
      const next = loadSettings()
      if (next.mediaDir) allowMediaDir(next.mediaDir)
      return { ...next, __save: report }
    } catch (e) {
      log(`set: EXCEÇÃO ${(e as Error).stack ?? (e as Error).message}`)
      return { __save: { ok: false, path: '?', error: (e as Error).message } }
    }
  })
  ipcMain.handle('settings:path', async () => settingsFilePath())

  // AI generation.
  ipcMain.handle('ai:generate', async (e, payload) => {
    return generateVideo(payload, (status) => e.sender.send('ai:progress', status))
  })
  ipcMain.handle('ai:cancel', async () => cancelSeedanceGeneration())

  ipcMain.handle('ai:enhancePrompt', async (_e, payload) => enhancePrompt(payload))

  ipcMain.handle('luma:modify', async (e, payload) =>
    lumaModify(payload, (status) => e.sender.send('ai:progress', status))
  )

  ipcMain.handle('heygen:generate', async (e, payload) =>
    heygenGenerate(payload, (status) => e.sender.send('ai:progress', status))
  )

  ipcMain.handle('ai:gapFill', async (e, payload) =>
    gapFill(payload, (status) => e.sender.send('ai:progress', status))
  )

  ipcMain.handle('kling:generate', async (e, payload) =>
    klingGenerate(payload, (status) => e.sender.send('ai:progress', status))
  )

  ipcMain.handle('remake:analyze', async (e, sourcePath) =>
    remakeAnalyze(sourcePath, (status) => e.sender.send('ai:progress', status))
  )
  ipcMain.handle('remake:refine', async (e, payload) =>
    remakeRefine(payload, (status) => e.sender.send('ai:progress', status))
  )

  // AI Producer budget governance.
  ipcMain.handle('budget:state', async () => budgetState())
  ipcMain.handle('budget:reserve', async (_e, payload) => budgetReserve(payload))
  ipcMain.handle('budget:reconcile', async (_e, payload) => budgetReconcile(payload))

  // Footage enhancement → writes an enhanced file into the media dir.
  ipcMain.handle('enhance:clip', async (e, payload) => {
    try {
      const s = loadSettings()
      const dir = s.mediaDir || join(app.getPath('userData'), 'generated')
      const { mkdirSync } = await import('fs')
      mkdirSync(dir, { recursive: true })
      const out = join(dir, `enhanced-${Date.now()}.mp4`)
      const finalPath = await enhanceClip(
        payload.path,
        payload.inPoint ?? 0,
        payload.duration ?? 5,
        { strength: payload.strength || 'medio', upscale: !!payload.upscale, warm: !!payload.warm },
        out,
        (p) => e.sender.send('enhance:progress', p)
      )
      return { ok: true, mediaPath: finalPath }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  // Clean up / normalize a clip's audio → new .m4a in the media dir.
  ipcMain.handle('audio:enhance', async (_e, payload) => {
    try {
      const s = loadSettings()
      const dir = s.mediaDir || join(app.getPath('userData'), 'generated')
      const { mkdirSync } = await import('fs')
      mkdirSync(dir, { recursive: true })
      const out = join(dir, `audio-${Date.now()}.m4a`)
      const finalPath = await enhanceAudio(
        payload.path,
        payload.inPoint ?? 0,
        payload.duration ?? 5,
        {
          denoise: !!payload.denoise,
          denoiseAmount: Number.isFinite(Number(payload.denoiseAmount)) ? Number(payload.denoiseAmount) : 0.25,
          normalize: !!payload.normalize,
          voice: !!payload.voice,
          compressor: !!payload.compressor,
          gainDb: Number(payload.gainDb) || 0,
          reverb: Number(payload.reverb) || 0,
          delayMs: Number(payload.delayMs) || 250,
          delayMix: Number(payload.delayMix) || 0,
          channels: ['mono', 'stereo'].includes(payload.channels) ? payload.channels : 'original'
        },
        out
      )
      return { ok: true, mediaPath: finalPath }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  // Apply the cinematic "reference look" match-grade to a clip's source.
  ipcMain.handle('look:apply', async (e, payload) => {
    try {
      const s = loadSettings()
      const dir = s.mediaDir || join(app.getPath('userData'), 'generated')
      const { mkdirSync } = await import('fs')
      mkdirSync(dir, { recursive: true })
      const out = join(dir, `look-${Date.now()}.mp4`)
      const finalPath = await applyLook(
        payload.path,
        payload.inPoint ?? 0,
        payload.duration ?? 5,
        out,
        (p) => e.sender.send('look:progress', p)
      )
      return { ok: true, mediaPath: finalPath }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  // Measure a clip and return a bounded, non-destructive colour correction.
  ipcMain.handle('clip:autoGrade', async (_e, payload) => {
    try {
      const g = await autoGradeClip(payload.path, payload.inPoint ?? 0, payload.duration ?? 5)
      return { ok: true, ...g }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  })

  // ---- Recording (webcam/mic → timeline) ----
  ipcMain.handle(
    'record:save',
    async (_e, payload: { bytes: ArrayBuffer; baseName: string; fps: number; hasAudio: boolean }) => {
      const rec = await saveRecording(
        app.getPath('userData'),
        new Uint8Array(payload.bytes),
        payload.baseName,
        payload.fps,
        payload.hasAudio
      )
      allowMediaPath(rec.path)
      return rec
    }
  )

  // Flight recorder: the renderer reports main-thread stalls here; they land in
  // userData/perf.log so a freeze produces facts instead of a shrug.
  ipcMain.handle('perf:log', (_e, line: string) => {
    try {
      const f = join(app.getPath('userData'), 'perf.log')
      require('fs').appendFileSync(f, `${new Date().toISOString()} ${line}
`)
    } catch {
      /* logging must never hurt */
    }
  })

  // ---- Gravação em fluxo: os pedaços vão ao disco assim que chegam ----
  ipcMain.handle('record:streamOpen', (_e, baseName: string) =>
    openRecordingStream(app.getPath('userData'), baseName)
  )
  ipcMain.handle('record:streamChunk', (_e, id: string, bytes: ArrayBuffer) =>
    writeRecordingChunk(id, new Uint8Array(bytes))
  )
  ipcMain.handle(
    'record:streamClose',
    async (_e, payload: { id: string; fps: number; hasAudio: boolean }) => {
      try {
        const rec = await closeRecordingStream(
          app.getPath('userData'), payload.id, payload.fps, payload.hasAudio
        )
        allowMediaPath(rec.path)
        return { ok: true, rec }
      } catch (err) {
        // Normalizar falhou — o .webm cru fica no disco de qualquer forma.
        const raw = await abortRecordingStream(payload.id)
        return { ok: false, error: String((err as Error).message || err), raw }
      }
    }
  )

  // Screen/window sources for screen recording (OBS-style capture).
  ipcMain.handle('record:screenSources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
    return sources.map((s) => ({ id: s.id, name: s.name }))
  })

  // ---- System audio (loopback) for gameplay capture ----
  // Chromium só entrega o som do sistema por getDisplayMedia, e só quando o
  // processo principal responde `audio: 'loopback'` no handler abaixo. O
  // caminho antigo (getUserMedia + chromeMediaSource:'desktop') NÃO captura
  // áudio no Windows — por isso a gravação de tela era muda até agora.
  // O renderer escolhe a fonte na lista e avisa aqui ANTES de chamar
  // getDisplayMedia, porque o handler não recebe essa escolha.
  let fonteDesejada: string | null = null
  ipcMain.handle('record:setDisplaySource', (_e, id: string | null) => {
    fonteDesejada = id
    return true
  })
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
      const escolhida = sources.find((s) => s.id === fonteDesejada) ?? sources[0]
      if (!escolhida) {
        callback({})
        return
      }
      // 'loopback' = som do sistema continua saindo nas caixas/fone enquanto é
      // gravado. ('loopbackWithMute' silenciaria a saída.) Só existe no Windows;
      // noutros sistemas o Electron ignora e a captura sai sem áudio.
      callback({ video: escolhida, audio: 'loopback' })
    },
    { useSystemPicker: false }
  )

  // ---- Voice isolation (ElevenLabs audio-isolation, user's key) ----
  // Generate an overlay element (transparent PNG) from a prompt.
  ipcMain.handle('elements:generate', async (_e, payload: { prompt: string; size?: string }) => {
    const res = await generateElement({
      prompt: payload.prompt,
      size: payload.size as never,
      outDir: join(app.getPath('userData'), 'generated', 'elements')
    })
    if (res.ok && res.path) allowMediaPath(res.path)
    return res
  })

  // ---- Personal Elements library (survives project switches / cleanup) ----
  ipcMain.handle('library:list', async () => listLibraryElements(app.getPath('userData')))
  ipcMain.handle('library:add', async (_e, item: Omit<LibraryItem, 'id' | 'createdAt'>) => {
    allowMediaPath(item.path)
    return addLibraryElement(app.getPath('userData'), item)
  })
  ipcMain.handle('library:remove', async (_e, payload: { id: string; deleteFile: boolean }) =>
    removeLibraryElement(app.getPath('userData'), payload.id, payload.deleteFile)
  )
  // Elements generated before the library existed: real files, no index entry.
  // Probe each and back-fill so nothing generated in the past stays invisible.
  ipcMain.handle('library:scanOrphans', async () => {
    const userData = app.getPath('userData')
    const orphans = findOrphanedElementFiles(userData)
    let imported = 0
    for (const p of orphans) {
      try {
        const meta = await prepareMedia(p, join(userData, 'audio-cache'))
        addLibraryElement(userData, {
          name: p.split(/[\\/]/).pop() || p,
          path: p,
          type: 'image',
          width: meta.width,
          height: meta.height,
          source: 'ai'
        })
        allowMediaPath(p)
        imported++
      } catch {
        /* unreadable/corrupt file — skip it, don't fail the whole scan */
      }
    }
    return { imported }
  })

  // ---- Animated overlay FX (offscreen canvas → transparent WebM, local) ----
  ipcMain.handle('fx:catalog', async () => FX_CATALOG)
  ipcMain.handle(
    'fx:render',
    async (e, payload: { id: string; width: number; height: number; fps: number; seconds?: number }) => {
      try {
        const res = await renderFx({
          ...payload,
          outDir: join(app.getPath('userData'), 'generated'),
          onProgress: (pct) => e.sender.send('fx:progress', pct)
        })
        allowMediaPath(res.path)
        return { ok: true, ...res }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('eleven:balance', async () => elevenBalance())
  ipcMain.handle('eleven:isolate', async (_e, payload) => {
    const res = await elevenIsolate({
      ...payload,
      outDir: join(app.getPath('userData'), 'generated', 'eleven')
    })
    if (res.ok && res.mediaPath) allowMediaPath(res.mediaPath)
    return res
  })

  // ---- Background removal (RobustVideoMatting, local) ----
  ipcMain.handle('matte:available', async () => matteAvailable())
  ipcMain.handle('matte:clip', async (e, srcPath: string) => {
    const outDir = join(app.getPath('userData'), 'matted')
    const res = await matteClip(srcPath, outDir, (p) => e.sender.send('matte:progress', p))
    allowMediaPath(res.path)
    return res
  })

  // ---- Transcription (local faster-whisper, no upload) ----
  ipcMain.handle('transcribe:available', async () => transcriptionAvailable())
  ipcMain.handle('transcribe:media', async (_e, payload) => {
    const cacheDir = join(app.getPath('userData'), 'transcripts')
    const res = await transcribeMedia(payload.path, cacheDir, { model: payload.model, language: payload.language })
    if (!res.ok || !res.transcript) return res
    return { ok: true, transcript: res.transcript, dead: findDeadRanges(res.transcript, payload.deadOpts || {}) }
  })
  ipcMain.handle('transcribe:saveSrt', async (_e, payload: { transcript: Transcript; offset?: number }) => {
    const res = await dialog.showSaveDialog(mainWindow!, {
      title: 'Salvar legendas',
      defaultPath: 'legendas.srt',
      filters: [{ name: 'SubRip', extensions: ['srt'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false }
    writeFileSync(res.filePath, buildSrt(payload.transcript, 2, true, payload.offset || 0), 'utf-8')
    return { ok: true, path: res.filePath }
  })

  ipcMain.handle('app:ffmpegInfo', async () => getFfmpegInfo())

  ipcMain.handle('shell:showItem', async (_e, p: string) => shell.showItemInFolder(p))

  // Launch NVIDIA Broadcast (so the user can enable its Camera tab without
  // leaving the app). Returns false if it isn't installed at the known path.
  ipcMain.handle('shell:openBroadcast', async () => {
    // NVIDIA Broadcast is Windows-only — there is no macOS/Linux build to open.
    if (process.platform !== 'win32') return false
    const exe = 'C:\\Program Files\\NVIDIA Corporation\\NVIDIA Broadcast\\NVIDIA Broadcast.exe'
    if (!existsSync(exe)) return false
    const err = await shell.openPath(exe)
    return err === ''
  })

  // Project save / open / autosave.
  ipcMain.handle('project:save', async (_e, data) => saveProjectDialog(mainWindow!, data))
  ipcMain.handle('project:open', async () => {
    const data = await openProjectDialog(mainWindow!)
    allowProjectMedia(data)
    return data
  })
  ipcMain.handle('project:autosaveWrite', async (_e, data) => writeAutosave(data))
  ipcMain.handle('project:autosaveRead', async () => {
    const data = readAutosave()
    allowProjectMedia(data)
    return data
  })

  // Named sessions.
  ipcMain.handle('session:save', async (_e, payload) => saveSession(payload.name, payload.data))
  ipcMain.handle('session:list', async () => listSessions())
  ipcMain.handle('session:load', async (_e, file: string) => {
    const data = loadSession(file)
    allowProjectMedia(data)
    return data
  })
  ipcMain.handle('session:delete', async (_e, file: string) => deleteSession(file))

  // Automatic timestamped project snapshots — the "undo" for a lost session.
  ipcMain.handle('snapshot:list', async () => listSnapshots())
  ipcMain.handle('snapshot:load', async (_e, file: string) => {
    const data = loadSnapshot(file)
    allowProjectMedia(data)
    return data
  })

  // Write a base64 PNG (rasterized text overlay) to a temp file for export.
  ipcMain.handle('file:writeTempPng', async (_e, base64: string) => {
    const path = join(tmpdir(), `vedit-text-${Date.now()}-${Math.round(performance.now())}.png`)
    writeFileSync(path, Buffer.from(base64, 'base64'))
    return path
  })
}
