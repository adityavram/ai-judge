const API_BASE = import.meta.env.VITE_API_BASE ?? ''

export interface SpeakerSegment {
  speaker: string
  text: string
  startTime: number
  endTime: number
}

export interface Transcript {
  videoId: string
  segments: SpeakerSegment[]
  rawSegments: { text: string; start: number; duration: number }[]
}

export async function fetchTranscript(url: string): Promise<Transcript> {
  const res = await fetch(`${API_BASE}/api/transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}