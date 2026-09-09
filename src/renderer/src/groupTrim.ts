import type { Clip } from './types'
import type { RippleFollower } from './rippleTrim'

/** One clip's state as it was when the trim drag started. */
export interface TrimMember {
  start: number
  duration: number
  inPoint: number
  speed: number
  /** Length of the underlying file; Infinity for stills, which stretch freely. */
  srcDur: number
  followers: RippleFollower[]
}

export const MIN_DUR = 0.1

/**
 * How far a group trim may actually go, given the raw mouse delta.
 *
 * The clamps are COLLECTIVE on purpose: the tightest limit in the selection
 * stops every member. Clamping each clip on its own would let a long clip keep
 * growing after a short one already hit its source end, and the selection would
 * silently drift out of sync — the opposite of what a group trim is for.
 */
export function clampTrimDelta(
  members: Iterable<TrimMember>,
  dx: number,
  mode: 'trim-left' | 'trim-right'
): number {
  let delta = dx
  for (const o of members) {
    if (mode === 'trim-left') {
      delta = Math.max(delta, -o.inPoint / o.speed) // inPoint may not go negative
      delta = Math.min(delta, o.duration - MIN_DUR)
    } else {
      delta = Math.max(delta, MIN_DUR - o.duration)
      if (isFinite(o.srcDur)) delta = Math.min(delta, (o.srcDur - o.inPoint) / o.speed - o.duration)
    }
  }
  return delta
}

/** The per-clip patch for a trim of `delta` seconds. */
export function trimPatch(
  o: TrimMember,
  delta: number,
  mode: 'trim-left' | 'trim-right'
): Partial<Clip> {
  return mode === 'trim-left'
    ? {
        start: Math.max(0, o.start + delta),
        inPoint: o.inPoint + delta * o.speed,
        duration: o.duration - delta
      }
    : { duration: o.duration + delta }
}

/**
 * Close the timeline around the trim. Each trimmed clip pushes its own
 * downstream chain, and the shifts ACCUMULATE — a clip that follows two trimmed
 * clips on the same track moves by twice the delta.
 */
export function applyTrimRipple(
  clips: Clip[],
  members: Map<string, TrimMember>,
  durationDelta: number
): Clip[] {
  const shift = new Map<string, number>()
  const followerStart = new Map<string, number>()
  for (const o of members.values())
    for (const f of o.followers) {
      shift.set(f.id, (shift.get(f.id) ?? 0) + durationDelta)
      followerStart.set(f.id, f.start)
    }
  return clips.map((c) => {
    const t = members.get(c.id)
    const sh = shift.get(c.id) ?? 0
    if (t) {
      // Ripple trim: a trimmed clip that has followers keeps its original left
      // edge and the timeline closes around it. One without followers stays
      // where the drag left it.
      const base = t.followers.length > 0 ? t.start : c.start
      return { ...c, start: Math.max(0, base + sh) }
    }
    if (!sh) return c
    return { ...c, start: Math.max(0, (followerStart.get(c.id) ?? c.start) + sh) }
  })
}
