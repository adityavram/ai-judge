import { Router } from 'express'
import { YoutubeTranscript } from 'youtube-transcript'
import { extractVideoId, assignSpeakers } from '../diarization.js'
import type { CaptionSegment, Transcript } from '../types.js'

const router = Router()

router.post('/', async (req, res) => {
  const { url } = req.body as { url?: string }

  if (!url) {
    return res.status(400).json({ error: 'Missing "url" in request body' })
  }

  const videoId = extractVideoId(url)
  if (!videoId) {
    return res.status(400).json({ error: 'Could not extract video ID from URL' })
  }

  try {
    const rawCaptions = await YoutubeTranscript.fetchTranscript(videoId)

    if (!rawCaptions || rawCaptions.length === 0) {
      return res.status(404).json({ error: 'No transcript available for this video' })
    }

    const captionSegments: CaptionSegment[] = rawCaptions.map((c) => ({
      text: c.text,
      start: c.offset,
      duration: c.duration,
    }))

    const speakerSegments = assignSpeakers(captionSegments)

    const transcript: Transcript = {
      videoId,
      rawSegments: captionSegments,
      segments: speakerSegments,
    }

    res.json(transcript)
  } catch (err) {
    console.error('Transcript fetch error:', err)
    res.status(500).json({
      error: 'Failed to fetch transcript',
      detail: err instanceof Error ? err.message : 'Unknown error',
    })
  }
})

export default router