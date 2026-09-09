// Above 100%, map the editor's percentage to perceived loudness rather than
// raw signal amplitude. +10 dB (200%) is commonly heard as roughly twice loud.
export function clipVolumeGain(volume: number): number {
  const v = Math.max(0, Math.min(2, volume))
  return v <= 1 ? v : Math.pow(10, ((v - 1) * 10) / 20)
}
