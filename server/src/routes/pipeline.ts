import { Router } from 'express'
import { randomUUID } from 'crypto'
import { YoutubeTranscript } from 'youtube-transcript'
import { extractVideoId, assignSpeakers } from '../diarization.js'
import { generateFlowSheet } from '../flow.js'
import { judgeRound } from '../judge.js'
import { llmChat, LlmError, llmErrorToResponse } from '../llm.js'
import { rateLimit, requireClientId } from '../rateLimit.js'
import type { CaptionSegment, Transcript, FlowSheet, JudgingResult } from '../types.js'

const router = Router()

const MAX_URL_LENGTH = 500
const MAX_TOPIC_LENGTH = 300

export type PipelineStatus = 'transcript' | 'flow' | 'judge' | 'done' | 'error'

interface PipelineJob {
  id: string
  status: PipelineStatus
  url: string
  topic: string
  transcript: Transcript | null
  flow: FlowSheet | null
  judging: JudgingResult | null
  error: string | null
  errorStep: string | null
  createdAt: number
}

const jobs = new Map<string, PipelineJob>()

const JOB_TTL_MS = 30 * 60 * 1000
const MAX_JOBS = 200

function cleanupOldJobs(): void {
  const now = Date.now()
  const expired: string[] = []
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) expired.push(id)
  }
  for (const id of expired) jobs.delete(id)

  if (jobs.size > MAX_JOBS) {
    const sorted = [...jobs.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)
    const toRemove = sorted.slice(0, jobs.size - MAX_JOBS)
    for (const [id] of toRemove) jobs.delete(id)
  }
}

async function inferTopic(text: string): Promise<string> {
  const sampleText = text.slice(0, 3000)
  const system = `You are an APDA debate expert. Given the opening speech of a debate round, infer the debate topic/motion. Respond with ONLY the topic as a short phrase (e.g. "This House would ban social media for minors"). No preamble, no quotes, no explanation.`
  const user = `Here is the opening speech of a debate. Infer the topic/motion being debated:\n\n${sampleText}`
  const response = await llmChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.1,
    label: 'pipeline:infer-topic',
  })
  return response.content.trim()
}

async function runPipeline(job: PipelineJob, url: string, topic?: string): Promise<void> {
  try {
    // Step 1: Transcript
    job.status = 'transcript'
    const videoId = extractVideoId(url)
    if (!videoId) {
      job.status = 'error'
      job.errorStep = 'Transcript'
      job.error = 'Could not extract video ID from URL'
      return
    }

    const rawCaptions = await YoutubeTranscript.fetchTranscript(videoId)
    if (!rawCaptions || rawCaptions.length === 0) {
      job.status = 'error'
      job.errorStep = 'Transcript'
      job.error = 'No transcript available for this video'
      return
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
        console.log(`[pipeline:${job.id}] Inferring topic...`)
        const pmc = segments.find((s) => s.speaker.startsWith('PMC'))
        const pmcText = pmc?.text ?? segments[0]?.text ?? captionSegments.map((c) => c.text).join(' ')
        resolvedTopic = await inferTopic(pmcText)
        topicInferred = true
        console.log(`[pipeline:${job.id}] Inferred topic: ${resolvedTopic}`)

        if (segments.length > 1) {
          const { segments: revalidated } = await assignSpeakers(captionSegments, resolvedTopic)
          if (revalidated.length === segments.length) {
            revalidated.forEach((seg, i) => {
              if (segments[i]) segments[i].speaker = seg.speaker
            })
          }
        }
      } catch (err) {
        if (err instanceof LlmError && (err.kind === 'token_exhausted' || err.kind === 'config')) {
          job.status = 'error'
          job.errorStep = 'Transcript'
          job.error = llmErrorToResponse(err).error
          return
        }
        console.warn(`[pipeline:${job.id}] Topic inference failed, continuing without topic`)
        resolvedTopic = 'Unknown'
      }
    }

    job.transcript = {
      videoId,
      rawSegments: captionSegments,
      segments,
      segmentationConfidence: confidence,
      detectedSpeechCount,
      topic: resolvedTopic || 'Unknown',
      topicInferred,
    }

    // Step 2: Flow
    job.status = 'flow'
    console.log(`[pipeline:${job.id}] Generating flow sheet...`)
    job.flow = await generateFlowSheet(job.transcript.segments)

    // Step 3: Judge
    job.status = 'judge'
    console.log(`[pipeline:${job.id}] Judging round...`)
    job.judging = await judgeRound(job.flow, job.transcript.topic)

    job.status = 'done'
    console.log(`[pipeline:${job.id}] Complete! Winner: ${job.judging.winner}`)
  } catch (err) {
    const stepLabel = job.status === 'transcript' ? 'Transcript'
      : job.status === 'flow' ? 'Flow Sheet'
      : 'Judging'
    job.errorStep = stepLabel

    if (err instanceof LlmError) {
      console.error(`[pipeline:${job.id}] LLM error at ${job.status}:`, err.kind, err.message)
      const { error } = llmErrorToResponse(err)
      job.error = error
    } else {
      console.error(`[pipeline:${job.id}] Error at ${job.status}:`, err)
      job.error = err instanceof Error ? err.message : 'Unknown error'
    }

    job.status = 'error'
  }
}

router.post('/', rateLimit, async (req, res) => {
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

  cleanupOldJobs()

  const id = randomUUID()
  const job: PipelineJob = {
    id,
    status: 'transcript',
    url,
    topic: topic ?? '',
    transcript: null,
    flow: null,
    judging: null,
    error: null,
    errorStep: null,
    createdAt: Date.now(),
  }
  jobs.set(id, job)

  console.log(`[pipeline:${id}] Started for video ${videoId}`)
  runPipeline(job, url, topic).catch((err) => {
    console.error(`[pipeline:${id}] Unhandled error:`, err)
  })

  res.status(202).json({ id, status: job.status })
})

router.get('/:id', requireClientId, (req, res) => {
  const id = typeof req.params.id === 'string' ? req.params.id : req.params.id?.[0]
  const job = id ? jobs.get(id) : undefined

  if (!job) {
    return res.status(404).json({ error: 'Pipeline job not found' })
  }

  const response: Record<string, unknown> = {
    id: job.id,
    status: job.status,
    errorStep: job.errorStep,
    error: job.error,
  }

  if (job.transcript) response.transcript = job.transcript
  if (job.flow) response.flow = job.flow
  if (job.judging) response.judging = job.judging

  res.json(response)
})

export default router