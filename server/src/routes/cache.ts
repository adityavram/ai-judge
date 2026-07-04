/**
 * Cache inspection and round history endpoints.
 *
 * Public:
 *   GET /api/cache/rounds       — list all cached rounds (video ID, topic, what's available)
 *   GET /api/cache/rounds/:id   — load a full cached round (transcript + flow + judging)
 *
 * Admin (requires Bearer ADMIN_KEY):
 *   GET /api/cache/transcript/:id  — raw transcript cache
 *   GET /api/cache/flow/:id?topic= — flow cache
 *   GET /api/cache/judge/:id?topic= — judge cache
 */

import { Router } from 'express'
import { getCachedTranscript, getCachedFlow, getCachedJudge, getCachedRawTranscript, listCachedRounds } from '../db.js'

const router = Router()

const ADMIN_KEY = process.env.ADMIN_KEY ?? ''

function requireAdmin(req: { headers: Record<string, string | string[] | undefined> }, res: { status: (c: number) => { json: (b: object) => void } }, next: () => void): boolean {
  const auth = req.headers.authorization
  if (!ADMIN_KEY || auth !== `Bearer ${ADMIN_KEY}`) {
    res.status(401).json({ error: 'Unauthorized' })
    return false
  }
  next()
  return true
}

// Public: list all cached rounds
router.get('/rounds', (_req, res) => {
  try {
    const rounds = listCachedRounds()
    res.json(rounds)
  } catch (err) {
    console.error('Failed to list cached rounds:', err)
    res.status(500).json({ error: 'Failed to list cached rounds' })
  }
})

// Public: load a full cached round by video ID
router.get('/rounds/:videoId', (req, res) => {
  const videoId = req.params.videoId
  const transcript = getCachedTranscript(videoId)
  if (!transcript) return res.status(404).json({ error: 'Not found' })

  const flow = getCachedFlow(videoId, transcript.topic)
  const judge = getCachedJudge(videoId, transcript.topic)
  const rawTranscript = getCachedRawTranscript(videoId)

  const response: Record<string, unknown> = {
    videoId: transcript.video_id,
    topic: transcript.topic,
    topicInferred: transcript.topic_inferred === 1,
    hasTranscript: true,
    hasRawTranscript: rawTranscript !== null,
    hasFlow: flow !== null,
    hasJudge: judge !== null,
    createdAt: transcript.created_at,
  }

  response.transcript = {
    videoId: transcript.video_id,
    rawSegments: JSON.parse(transcript.raw_segments),
    segments: JSON.parse(transcript.segments),
    segmentationConfidence: transcript.confidence,
    detectedSpeechCount: transcript.detected_speech_count,
    topic: transcript.topic,
    topicInferred: transcript.topic_inferred === 1,
  }
  if (flow) response.flow = JSON.parse(flow.flow)
  if (judge) response.judging = JSON.parse(judge.result)

  res.json(response)
})

// Admin: inspect individual caches

router.get('/transcript/:videoId', (req, res) => {
  if (!requireAdmin(req, res, () => {})) return
  const videoId = req.params.videoId
  const cached = getCachedTranscript(videoId)
  if (!cached) return res.status(404).json({ error: 'Not found' })
  res.json({
    video_id: cached.video_id,
    topic: cached.topic,
    topic_inferred: cached.topic_inferred === 1,
    confidence: cached.confidence,
    detected_speech_count: cached.detected_speech_count,
    segments: JSON.parse(cached.segments),
    raw_segments: JSON.parse(cached.raw_segments),
    created_at: cached.created_at,
  })
})

router.get('/flow/:videoId', (req, res) => {
  if (!requireAdmin(req, res, () => {})) return
  const { videoId } = req.params
  const topic = req.query.topic as string | undefined
  if (!topic) return res.status(400).json({ error: 'topic query parameter required' })
  const cached = getCachedFlow(videoId, topic)
  if (!cached) return res.status(404).json({ error: 'Not found' })
  res.json({
    video_id: cached.video_id,
    topic: cached.topic,
    flow: JSON.parse(cached.flow),
    created_at: cached.created_at,
  })
})

router.get('/judge/:videoId', (req, res) => {
  if (!requireAdmin(req, res, () => {})) return
  const { videoId } = req.params
  const topic = req.query.topic as string | undefined
  if (!topic) return res.status(400).json({ error: 'topic query parameter required' })
  const cached = getCachedJudge(videoId, topic)
  if (!cached) return res.status(404).json({ error: 'Not found' })
  res.json({
    video_id: cached.video_id,
    topic: cached.topic,
    result: JSON.parse(cached.result),
    created_at: cached.created_at,
  })
})

export default router