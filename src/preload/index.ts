import { contextBridge, ipcRenderer } from 'electron'

const api = {
  openFiles: (): Promise<string[]> => ipcRenderer.invoke('dialog:openFiles'),
  probe: (path: string) => ipcRenderer.invoke('media:probe', path),
  checkMissingMedia: (paths: string[]): Promise<string[]> =>
    ipcRenderer.invoke('media:checkMissing', paths),
  relocateMedia: (missingNames: string[]): Promise<Record<string, string>> =>
    ipcRenderer.invoke('dialog:relocateMedia', missingNames),
  onImportProgress: (cb: (p: { path: string; pct: number; stage: string }) => void) => {
    const listener = (_e: unknown, p: any) => cb(p)
    ipcRenderer.on('import:progress', listener)
    return () => {
      ipcRenderer.removeListener('import:progress', listener)
    }
  },
  saveFileDialog: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveFile', defaultName),
  render: (payload: unknown) => ipcRenderer.invoke('export:render', payload),
  cancelRender: (): Promise<boolean> => ipcRenderer.invoke('export:cancel'),
  onExportProgress: (cb: (p: { percent: number; time: number }) => void) => {
    const listener = (_e: unknown, p: any) => cb(p)
    ipcRenderer.on('export:progress', listener)
    return () => {
      ipcRenderer.removeListener('export:progress', listener)
    }
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: unknown) => ipcRenderer.invoke('settings:set', patch),
  settingsPath: (): Promise<string> => ipcRenderer.invoke('settings:path'),
  generate: (payload: unknown) => ipcRenderer.invoke('ai:generate', payload),
  cancelAi: (): Promise<boolean> => ipcRenderer.invoke('ai:cancel'),
  enhancePrompt: (payload: { prompt: string; mode: string }) => ipcRenderer.invoke('ai:enhancePrompt', payload),
  lumaModify: (payload: unknown) => ipcRenderer.invoke('luma:modify', payload),
  heygenGenerate: (payload: unknown) => ipcRenderer.invoke('heygen:generate', payload),
  gapFill: (payload: unknown) => ipcRenderer.invoke('ai:gapFill', payload),
  klingGenerate: (payload: unknown) => ipcRenderer.invoke('kling:generate', payload),
  remakeAnalyze: (sourcePath: string) => ipcRenderer.invoke('remake:analyze', sourcePath),
  remakeRefine: (payload: unknown) => ipcRenderer.invoke('remake:refine', payload),
  budgetState: () => ipcRenderer.invoke('budget:state'),
  budgetReserve: (payload: unknown) => ipcRenderer.invoke('budget:reserve', payload),
  budgetReconcile: (payload: unknown) => ipcRenderer.invoke('budget:reconcile', payload),
  enhanceClip: (payload: unknown) => ipcRenderer.invoke('enhance:clip', payload),
  enhanceAudio: (payload: unknown) => ipcRenderer.invoke('audio:enhance', payload),
  autoGrade: (payload: unknown) => ipcRenderer.invoke('clip:autoGrade', payload),
  saveRecording: (payload: {
    bytes: ArrayBuffer
    baseName: string
    fps: number
    hasAudio: boolean
  }): Promise<{
    path: string
    duration: number
    width: number
    height: number
    hasAudio: boolean
    fps: number
  }> => ipcRenderer.invoke('record:save', payload),
  openBroadcast: (): Promise<boolean> => ipcRenderer.invoke('shell:openBroadcast'),
  recordStreamOpen: (baseName: string): Promise<string> =>
    ipcRenderer.invoke('record:streamOpen', baseName),
  recordStreamChunk: (id: string, bytes: ArrayBuffer): Promise<boolean> =>
    ipcRenderer.invoke('record:streamChunk', id, bytes),
  recordStreamClose: (payload: { id: string; fps: number; hasAudio: boolean }): Promise<{
    ok: boolean
    rec?: {
      path: string; duration: number; width: number; height: number
      hasAudio: boolean; fps: number
    }
    error?: string
    raw?: string | null
  }> => ipcRenderer.invoke('record:streamClose', payload),
  screenSources: (): Promise<Array<{ id: string; name: string }>> =>
    ipcRenderer.invoke('record:screenSources'),
  // avisa qual fonte o getDisplayMedia deve devolver (o handler do main não
  // recebe essa escolha por conta própria)
  setDisplaySource: (id: string | null): Promise<boolean> =>
    ipcRenderer.invoke('record:setDisplaySource', id),
  perfLog: (line: string): Promise<void> => ipcRenderer.invoke('perf:log', line),
  generateElement: (payload: { prompt: string; size?: string }): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('elements:generate', payload),
  libraryList: (): Promise<
    Array<{
      id: string
      name: string
      path: string
      type: 'image'
      width: number
      height: number
      prompt?: string
      source: 'ai' | 'upload'
      createdAt: number
    }>
  > => ipcRenderer.invoke('library:list'),
  libraryAdd: (item: {
    name: string
    path: string
    type: 'image'
    width: number
    height: number
    prompt?: string
    source: 'ai' | 'upload'
  }) => ipcRenderer.invoke('library:add', item),
  libraryRemove: (id: string, deleteFile: boolean): Promise<boolean> =>
    ipcRenderer.invoke('library:remove', { id, deleteFile }),
  libraryScanOrphans: (): Promise<{ imported: number }> => ipcRenderer.invoke('library:scanOrphans'),
  fxCatalog: (): Promise<Array<{ id: string; label: string; group: string; seconds: number; hint: string }>> =>
    ipcRenderer.invoke('fx:catalog'),
  fxRender: (payload: {
    id: string
    width: number
    height: number
    fps: number
    seconds?: number
  }): Promise<{ ok: boolean; path?: string; cached?: boolean; error?: string }> =>
    ipcRenderer.invoke('fx:render', payload),
  onFxProgress: (cb: (pct: number) => void) => {
    const listener = (_e: unknown, p: number) => cb(p)
    ipcRenderer.on('fx:progress', listener)
    return () => {
      ipcRenderer.removeListener('fx:progress', listener)
    }
  },
  elevenBalance: (): Promise<{ ok: boolean; remaining?: number; limit?: number; error?: string }> =>
    ipcRenderer.invoke('eleven:balance'),
  elevenIsolate: (payload: {
    path: string
    inPoint: number
    duration: number
    isVideo: boolean
  }): Promise<{ ok: boolean; mediaPath?: string; error?: string }> =>
    ipcRenderer.invoke('eleven:isolate', payload),
  matteAvailable: (): Promise<boolean> => ipcRenderer.invoke('matte:available'),
  matteClip: (path: string): Promise<{ path: string; frames: number; provider: string }> =>
    ipcRenderer.invoke('matte:clip', path),
  onMatteProgress: (cb: (p: number) => void) => {
    const listener = (_e: unknown, p: number) => cb(p)
    ipcRenderer.on('matte:progress', listener)
    return () => {
      ipcRenderer.removeListener('matte:progress', listener)
    }
  },
  transcriptionAvailable: () => ipcRenderer.invoke('transcribe:available'),
  transcribeMedia: (payload: unknown) => ipcRenderer.invoke('transcribe:media', payload),
  saveSrt: (payload: unknown) => ipcRenderer.invoke('transcribe:saveSrt', payload),
  onEnhanceProgress: (cb: (p: number) => void) => {
    const listener = (_e: unknown, p: number) => cb(p)
    ipcRenderer.on('enhance:progress', listener)
    return () => {
      ipcRenderer.removeListener('enhance:progress', listener)
    }
  },
  applyLook: (payload: unknown) => ipcRenderer.invoke('look:apply', payload),
  onLookProgress: (cb: (p: number) => void) => {
    const listener = (_e: unknown, p: number) => cb(p)
    ipcRenderer.on('look:progress', listener)
    return () => {
      ipcRenderer.removeListener('look:progress', listener)
    }
  },
  onAiProgress: (cb: (s: { stage: string; message: string }) => void) => {
    const listener = (_e: unknown, s: any) => cb(s)
    ipcRenderer.on('ai:progress', listener)
    return () => {
      ipcRenderer.removeListener('ai:progress', listener)
    }
  },
  ffmpegInfo: () => ipcRenderer.invoke('app:ffmpegInfo'),
  showItem: (p: string) => ipcRenderer.invoke('shell:showItem', p),
  saveProject: (data: unknown) => ipcRenderer.invoke('project:save', data),
  openProject: () => ipcRenderer.invoke('project:open'),
  autosaveWrite: (data: unknown): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('project:autosaveWrite', data),
  autosaveRead: () => ipcRenderer.invoke('project:autosaveRead'),
  sessionSave: (name: string, data: unknown) => ipcRenderer.invoke('session:save', { name, data }),
  sessionList: (): Promise<Array<{ name: string; file: string; mtime: number }>> =>
    ipcRenderer.invoke('session:list'),
  sessionLoad: (file: string) => ipcRenderer.invoke('session:load', file),
  sessionDelete: (file: string): Promise<boolean> => ipcRenderer.invoke('session:delete', file),
  snapshotList: (): Promise<Array<{ file: string; name: string; mtime: number; clips: number }>> =>
    ipcRenderer.invoke('snapshot:list'),
  snapshotLoad: (file: string) => ipcRenderer.invoke('snapshot:load', file),
  onProjectExternalChange: (cb: (data: unknown) => void) => {
    const listener = (_e: unknown, data: unknown) => cb(data)
    ipcRenderer.on('project:externalChange', listener)
    return () => {
      ipcRenderer.removeListener('project:externalChange', listener)
    }
  },
  writeTempPng: (base64: string): Promise<string> => ipcRenderer.invoke('file:writeTempPng', base64),
  // Build a media:// URL the renderer can feed to <video>/<img>.
  mediaUrl: (path: string) => `media://local/?p=${encodeURIComponent(path)}`
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
