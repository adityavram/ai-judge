import { Router } from 'express'
import { YoutubeTranscript } from 'youtube-transcript'
import { extractVideoId, assignSpeakers } from '../diarization.js'
import { llmChat, LlmError, llmErrorToResponse } from '../llm.js'
import type { CaptionSegment, Transcript } from '../types.js'

const router = Router()

const MAX_URL_LENGTH = 500
const MAX_TOPIC_LENGTH = 300

const YT_RETRY_DELAY_MS = 5000
const YT_MAX_RETRIES = 2

function isYoutubeCaptchaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return /captcha|too many requests|rate.limit/i.test(err.message)
}

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
    // Fetch YouTube transcript with retry on captcha/rate-limit
    let rawCaptions: Awaited<ReturnType<typeof YoutubeTranscript.fetchTranscript>> | null = null
    for (let attempt = 0; attempt <= YT_MAX_RETRIES; attempt++) {
      try {
        rawCaptions = await YoutubeTranscript.fetchTranscript(videoId)
        break
      } catch (err) {
        if (isYoutubeCaptchaError(err) && attempt < YT_MAX_RETRIES) {
          console.warn(`[transcript] YouTube captcha/rate-limit on attempt ${attempt + 1}, retrying...`)
          await new Promise((r) => setTimeout(r, YT_RETRY_DELAY_MS * (attempt + 1)))
          continue
        }
        if (isYoutubeCaptchaError(err)) {
          return res.status(503).json({
            error: 'YouTube is temporarily rate-limiting our server. Please try again in a few minutes.',
          })
        }
        throw err
      }
    }

    if (!rawCaptions || rawCaptions.length === 0) {
      return res.status(404).json({ error: 'No transcript available for this video' })
    }

    const captionSegments: CaptionSegment[] = rawCaptions.map((c) => ({
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