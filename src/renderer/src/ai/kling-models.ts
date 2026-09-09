// Kling developer-API image2video / text2video models (official).
// `tail` = supports image_tail (first + last frame interpolation).
export interface KlingModel {
  id: string
  label: string
  tail: boolean
  tailAllModes?: boolean // image_tail works in std too (else Pro only)
}

export const KLING_MODELS: KlingModel[] = [
  { id: 'kling-v2-6', label: 'Kling 2.6 (mais recente)', tail: true, tailAllModes: true },
  { id: 'kling-v2-5-turbo', label: 'Kling 2.5 Turbo', tail: true },
  { id: 'kling-v2-1', label: 'Kling 2.1', tail: true },
  { id: 'kling-v2-1-master', label: 'Kling 2.1 Master', tail: false },
  { id: 'kling-v2-master', label: 'Kling 2.0 Master', tail: false },
  { id: 'kling-v1-6', label: 'Kling 1.6', tail: true },
  { id: 'kling-v1-5', label: 'Kling 1.5', tail: true },
  { id: 'kling-v1', label: 'Kling 1.0', tail: false }
]

export const KLING_TAIL_MODELS = KLING_MODELS.filter((m) => m.tail)
