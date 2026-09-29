// Audio waveform peaks + video thumbnail generation (renderer-side, cached).

const thumbCache = new Map<string, string>()

// Os picos de áudio agora vêm do processo principal via ffmpeg
// (window.api.mediaPeaks, src/main/ffmpeg.ts computePeaksFfmpeg) em vez de
// carregar o arquivo inteiro aqui: medido em 11,9s de arrayBuffer() + 1,7s de
// decodeAudioData e 500MB de RAM transitória para um vídeo de 6,5min/502MB.

export function getThumbnail(path: string): Promise<string> {
  if (thumbCache.has(path)) return Promise.resolve(thumbCache.get(path)!)
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.src = `media://local/?p=${encodeURIComponent(path)}`
    v.muted = true
    v.preload = 'auto'
    const onSeeked = (): void => {
      try {
        const c = document.createElement('canvas')
        c.width = 160
        c.height = 90
        c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height)
        const d = c.toDataURL('image/jpeg', 0.6)
        thumbCache.set(path, d)
        resolve(d)
      } catch (err) {
        reject(err as Error)
      }
    }
    v.addEventListener('loadeddata', () => {
      try {
        v.currentTime = Math.min(1, (v.duration || 0.2) / 2)
      } catch {
        /* ignore */
      }
    })
    v.addEventListener('seeked', onSeeked, { once: true })
    v.addEventListener('error', () => reject(new Error('thumbnail error')))
  })
}
