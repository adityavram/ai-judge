import { Router } from 'express'
import { extractVideoId, assignSpeakers } from '../diarization.js'
import { llmChat, LlmError, llmErrorToResponse } from '../llm.js'
import { getCachedTranscript, saveTranscriptCache } from '../db.js'
import { fetchYouTubeTranscript, YouTubeRateLimitError, YouTubeNoTranscriptError } from '../youtube.js'
import type { CaptionSegment, Transcript } from '../types.js'

const router = Router()

const MAX_URL_LENGTH = 500
const MAX_TOPIC_LENGTH = 300

async function inferTopic(text: string): Promise<string> {
  const sampleText = text.slice(0, 3000)

  const system = `You are an APDA debate expert. Given the opening speech of a debate round, infer the debate topic/motion. Respond with ONLY the topic as a short phrase (e.g. "This House would ban social media for minors"). No preamble, no quotes, no explanation.`

  const user = `Here is the opening speech of a debate. Infer the topic/motion being debated:

${sampleText}`

  const response = await llmChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.1,
    label: 'transcript:infer-topic',
  })

  return response.content.trim()
}

router.post('/', async (req, res) => {
  const { url, topic } = req.body as { url?: string; topic?: string }

  if (!url || typeof url !== 'string' || url.length > MAX_URL_LENGTH) {
    return res.status(400).json({ error: 'Valid YouTube URL required' })
  }
  if (topic && typeof topic === 'string' && topic.length > MAX_TOPIC_LENGTH) {
    return res.status(400).json({ error: 'Topic is too long' })
  }

  const videoId = extractVideoId(url)
  if (!videoId) {
    return res.status(400).json({ error: 'Could not extract video ID from URL' })
  }

  try {
    // Check cache first
    const cached = getCachedTranscript(videoId)
    if (cached) {
      console.log(`[transcript] Cache hit for video ${videoId}`)
      const transcript: Transcript = {
        videoId: cached.video_id,
        rawSegments: JSON.parse(cached.raw_segments),
        segments: JSON.parse(cached.segments),
        segmentationConfidence: cached.confidence as 'high' | 'low',
        detectedSpeechCount: cached.detected_speech_count,
        topic: cached.topic,
        topicInferred: cached.topic_inferred === 1,
      }
      return res.json(transcript)
    }

    // Fetch YouTube transcript via InnerTube (no HTML scraping = no captchas)
    let captionData: { text: string; offset: number; duration: number }[]
    try {
      captionData = await fetchYouTubeTranscript(videoId)
    } catch (err) {
      if (err instanceof YouTubeRateLimitError) {
        return res.status(503).json({
          error: 'YouTube is temporarily rate-limiting our server. Please try again in a few minutes.',
        })
      }
      if (err instanceof YouTubeNoTranscriptError) {
        return res.status(404).json({ error: err.message })
      }
      throw err
    }

    if (!captionData || captionData.length === 0) {
      return res.status(404).json({ error: 'No transcript available for this video' })
    }

    const captionSegments: CaptionSegment[] = captionData.map((c) => ({
      text: c.text,
      start: c.offset / 1000,
      duration: c.duration / 1000,
    }))

    let resolvedTopic = topic?.trim() ?? ''
    let topicInferred = false

    const { segments, confidence, detectedSpeechCount } = await assignSpeakers(captionSegments, resolvedTopic || undefined)

    if (!resolvedTopic) {
      try {
        console.log('[transcript] No topic provided, inferring from PMC block...')
        const pmc = segments.find((s) => s.speaker.startsWith('PMC'))
        const pmcText = pmc?.text ?? segments[0]?.text ?? captionSegments.map((c) => c.text).join(' ')
        resolvedTopic = await inferTopic(pmcText)
        topicInferred = true
        console.log(`[transcript] Inferred topic: ${resolvedTopic}`)

        if (segments.length > 1) {
          console.log('[transcript] Re-validating speech roles with inferred topic...')
          const { segments: revalidated } = await assignSpeakers(captionSegments, resolvedTopic)
          if (revalidated.length === segments.length) {
            revalidated.forEach((seg, i) => {
              if (segments[i]) segments[i].speaker = seg.speaker
            })
          }
        }
      } catch (err) {
        if (err instanceof LlmError) {
          console.error('[transcript] Topic inference LLM error:', err.message)
          if (err.kind === 'token_exhausted' || err.kind === 'config') {
            const { error, detail } = llmErrorToResponse(err)
            return res.status(err.statusCode).json({ error, detail })
          }
          console.warn('[transcript] Topic inference failed, continuing without topic')
          resolvedTopic = 'Unknown'
        } else {
          console.warn('[transcript] Topic inference failed:', err instanceof Error ? err.message : err)
          resolvedTopic = 'Unknown'
        }
      }
    }

    const transcript: Transcript = {
      videoId,
      rawSegments: captionSegments,
      segments,
      segmentationConfidence: confidence,
      detectedSpeechCount,
      topic: resolvedTopic || 'Unknown',
      topicInferred,
    }

    // Save to cache (best-effort)
    try {
      saveTranscriptCache(
        videoId,
        JSON.stringify(transcript.rawSegments),
        JSON.stringify(transcript.segments),
        transcript.segmentationConfidence,
        transcript.detectedSpeechCount,
        transcript.topic,
        transcript.topicInferred,
      )
      console.log(`[transcript] Cached transcript for video ${videoId}`)
    } catch (cacheErr) {
      console.warn('[transcript] Failed to cache transcript:', cacheErr instanceof Error ? cacheErr.message : cacheErr)
    }

    res.json(transcript)
  } catch (err) {
    if (err instanceof LlmError) {
      console.error('[transcript] LLM error:', err.kind, err.message)
      const { error, detail } = llmErrorToResponse(err)
      return res.status(err.statusCode).json({ error, detail })
    }
    console.error('Transcript fetch error:', err)
    res.status(500).json({
      error: 'Failed to fetch transcript',
      detail: err instanceof Error ? err.message : 'Unknown error',
    })
  }
})

export default router