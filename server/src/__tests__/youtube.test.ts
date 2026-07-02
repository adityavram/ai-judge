import { describe, it, expect } from 'vitest'
import { extractVideoId, fetchYouTubeTranscript } from '../youtube.js'

describe('extractVideoId', () => {
  it('extracts from standard watch URL', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=kkMkbYmr_wQ')).toBe('kkMkbYmr_wQ')
  })

  it('extracts from short URL', () => {
    expect(extractVideoId('https://youtu.be/kkMkbYmr_wQ')).toBe('kkMkbYmr_wQ')
  })

  it('extracts from embed URL', () => {
    expect(extractVideoId('https://www.youtube.com/embed/kkMkbYmr_wQ')).toBe('kkMkbYmr_wQ')
  })

  it('extracts from URL with timestamp', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=kkMkbYmr_wQ&t=21s')).toBe('kkMkbYmr_wQ')
  })

  it('extracts from short URL with timestamp', () => {
    expect(extractVideoId('https://youtu.be/kkMkbYmr_wQ?t=21')).toBe('kkMkbYmr_wQ')
  })

  it('returns null for non-YouTube URLs', () => {
    expect(extractVideoId('https://example.com')).toBeNull()
  })

  it('returns null for invalid IDs', () => {
    expect(extractVideoId('https://www.youtube.com/watch?v=short')).toBeNull()
  })

  it('handles bare video ID', () => {
    expect(extractVideoId('kkMkbYmr_wQ')).toBe('kkMkbYmr_wQ')
  })
})

describe('fetchYouTubeTranscript', () => {
  it('fetches transcript from a real debate video', async () => {
    const lines = await fetchYouTubeTranscript('kkMkbYmr_wQ')
    expect(lines.length).toBeGreaterThan(100)
    expect(lines[0]).toHaveProperty('text')
    expect(lines[0]).toHaveProperty('offset')
    expect(lines[0]).toHaveProperty('duration')
    expect(typeof lines[0].text).toBe('string')
    expect(typeof lines[0].offset).toBe('number')
    expect(typeof lines[0].duration).toBe('number')
  }, 30000)

  it('throws for invalid video ID', async () => {
    await expect(fetchYouTubeTranscript('invalid12345')).rejects.toThrow()
  }, 30000)

  it('returns lines with non-empty text', async () => {
    const lines = await fetchYouTubeTranscript('kkMkbYmr_wQ')
    const nonEmpty = lines.filter((l) => l.text.trim().length > 0)
    expect(nonEmpty.length).toBeGreaterThan(lines.length * 0.8)
  }, 30000)
})