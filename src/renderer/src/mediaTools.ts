// Audio waveform peaks + video thumbnail generation (renderer-side, cached).

const thumbCache = new Map<string, string>()

export async function computePeaks(path: string, buckets = 600): Promise<number[]> {
  const res = await fetch(`media://local/?p=${encodeURIComponent(path)}`)
  const buf = await res.arrayBuffer()
  const Ctx: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext
  const ctx = new Ctx()
  try {
    const audio = await ctx.decodeAudioData(buf)
    const data = audio.getChannelData(0)
    const block = Math.max(1, Math.floor(data.length / buckets))
    const peaks: number[] = []
    let max = 0.01
    for (let i = 0; i < buckets; i++) {
      let p = 0
      for (let j = 0; j < block; j++) {
        const v = Math.abs(data[i * block + j] || 0)
        if (v > p) p = v
      }
      peaks.push(p)
      if (p > max) max = p
    }
    return peaks.map((p) => p / max)
  } finally {
    ctx.close()
  }
}

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
