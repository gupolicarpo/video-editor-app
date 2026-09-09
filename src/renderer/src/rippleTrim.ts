import type { Clip } from './types'

export interface RippleFollower {
  id: string
  start: number
}

// Follow only the uninterrupted chain after this clip. Intentional gaps later
// on the same track must stay where the editor put them.
export function findRippleFollowers(clips: Clip[], target: Clip, tolerance = 0.05): RippleFollower[] {
  const sorted = clips
    .filter((c) => c.id !== target.id && c.trackId === target.trackId && c.start >= target.start + target.duration - tolerance)
    .sort((a, b) => a.start - b.start)

  const followers: RippleFollower[] = []
  let edge = target.start + target.duration
  for (const clip of sorted) {
    if (Math.abs(clip.start - edge) > tolerance) break
    followers.push({ id: clip.id, start: clip.start })
    edge = clip.start + clip.duration
  }
  return followers
}
