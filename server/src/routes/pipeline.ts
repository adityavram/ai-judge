/**
 * Async pipeline orchestration for the AI Judge.
 *
 * POST /api/pipeline — starts a new pipeline job, returns 202 with job ID
 * GET  /api/pipeline/:id — polls job status (transcript → diarize → flow → judge → done)
 *
 * Pipeline steps:
 * 1. Transcript: Fetch raw captions from YouTube (or raw_transcript_cache)
 * 2. Diarize: Segment captions into speaker-labeled speech blocks
 * 3. Flow: Extract arguments and cluster into clashes
 * 4. Judge: Weighing, clash verdicts, RFD, devil's advocate, speaker scores, feedback
 *
 * Resume/re-run via `resumeFrom` parameter:
 * - 'transcript': re-fetch from YouTube, re-diarize, re-flow, re-judge
 * - 'diarize':    skip YouTube fetch (use raw_transcript_cache), re-diarize, re-flow, re-judge
 * - 'flow':       skip to flow generation (use transcript_cache), re-judge
 * - 'judge':      skip to judging (use flow_cache)
 *
 * Jobs are stored in-memory with a 30-min TTL and 200-job cap.
 * Intermediate results (transcript, flow) appear in poll responses as they complete,
 * enabling progressive rendering on the client.
 */

import { Router } from 'express'
import { randomUUID } from 'crypto'
import { extractVideoId, fetchYouTubeTranscript, YouTubeRateLimitError, YouTubeNoTranscriptError } from '../youtube.js'
import { assignSpeakers } from '../diarization.js'
import { generateFlowSheet } from '../flow.js'
import { judgeRound } from '../judge.js'
import { llmChat, LlmError, llmErrorToResponse } from '../llm.js'
import { rateLimit, requireClientId } from '../rateLimit.js'
import { getCachedTranscript, saveTranscriptCache, getCachedFlow, saveFlowCache, getCachedJudge, saveJudgeCache, getCachedRawTranscript, saveRawTranscriptCache, getCustomParadigm } from '../db.js'
import { BUILTIN_PARADIGMS } from '../paradigms.js'
import type { CaptionSegment, Transcript, FlowSheet, JudgingResult } from '../types.js'

const router = Router()

const MAX_URL_LENGTH = 500
const MAX_TOPIC_LENGTH = 1000

export type PipelineStatus = 'transcript' | 'diarize' | 'flow' | 'judge' | 'done' | 'error'
export type ResumeFrom = 'transcript' | 'diarize' | 'flow' | 'judge'

interface PipelineJob {
  id: string
  status: PipelineStatus
  url: string
  topic: string
  videoId: string
  paradigmId: string
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

async function fetchTranscriptData(videoId: string): Promise<{ text: string; offset: number; duration: number }[]> {
  try {
    return await fetchYouTubeTranscript(videoId)
  } catch (err) {
    if (err instanceof YouTubeRateLimitError) {
      throw new Error('YouTube is temporarily rate-limiting our server. Please try again in a few minutes.')
    }
    if (err instanceof YouTubeNoTranscriptError) {
      throw new Error('No transcript available for this video. The video may not have captions enabled.')
    }
    throw err
  }
}

async function runPipeline(job: PipelineJob, topic?: string, resumeFrom?: ResumeFrom): Promise<void> {
  try {
    // Resolve paradigm prompt
    let paradigmPrompt = BUILTIN_PARADIGMS.find((p) => p.id === job.paradigmId)?.prompt
    if (!paradigmPrompt) {
      // Check custom paradigms
      const custom = getCustomParadigm(job.paradigmId)
      if (custom) {
        paradigmPrompt = custom.prompt
      } else {
        // Fallback to default
        paradigmPrompt = BUILTIN_PARADIGMS[0].prompt
        job.paradigmId = BUILTIN_PARADIGMS[0].id
      }
    }

    // Step 1a: Fetch raw captions from YouTube (or cache)
    // Step 1b: Diarize into speaker segments (or cache)
    // These are separate so we can re-diarize without re-fetching from YouTube.
    const cachedTranscript = (resumeFrom !== 'transcript' && resumeFrom !== 'diarize') ? getCachedTranscript(job.videoId) : null
    if (cachedTranscript) {
      console.log(`[pipeline:${job.id}] Cache hit for transcript`)
      job.transcript = {
        videoId: cachedTranscript.video_id,
        rawSegments: JSON.parse(cachedTranscript.raw_segments),
        segments: JSON.parse(cachedTranscript.segments),
        segmentationConfidence: cachedTranscript.confidence as 'high' | 'low',
        detectedSpeechCount: cachedTranscript.detected_speech_count,
        topic: cachedTranscript.topic,
        topicInferred: cachedTranscript.topic_inferred === 1,
      }
    }

    if (!job.transcript) {
      let captionSegments: CaptionSegment[]

      // Try raw transcript cache first (unless re-pulling from YouTube)
      const cachedRaw = (resumeFrom !== 'transcript') ? getCachedRawTranscript(job.videoId) : null
      if (cachedRaw) {
        console.log(`[pipeline:${job.id}] Cache hit for raw transcript`)
        const rawCaptions = JSON.parse(cachedRaw.raw_captions) as { text: string; offset: number; duration: number }[]
        captionSegments = rawCaptions.map((c) => ({
          text: c.text,
          start: c.offset / 1000,
          duration: c.duration / 1000,
        }))
      } else {
        job.status = 'transcript'
        const rawCaptions = await fetchTranscriptData(job.videoId)

        // Cache raw captions (before diarization)
        try {
          saveRawTranscriptCache(job.videoId, JSON.stringify(rawCaptions))
          console.log(`[pipeline:${job.id}] Cached raw transcript for video ${job.videoId}`)
        } catch (cacheErr) {
          console.warn(`[pipeline:${job.id}] Failed to cache raw transcript:`, cacheErr instanceof Error ? cacheErr.message : cacheErr)
        }

        captionSegments = rawCaptions.map((c) => ({
          text: c.text,
          start: c.offset / 1000,
          duration: c.duration / 1000,
        }))
      }

      // Diarize: assign speaker labels
      let resolvedTopic = topic?.trim() ?? ''
      let topicInferred = false

      job.status = 'diarize'
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
        videoId: job.videoId,
        rawSegments: captionSegments,
        segments,
        segmentationConfidence: confidence,
        detectedSpeechCount,
        topic: resolvedTopic || 'Unknown',
        topicInferred,
      }

      // Cache full transcript (after diarization)
      try {
        saveTranscriptCache(
          job.videoId,
          JSON.stringify(job.transcript.rawSegments),
          JSON.stringify(job.transcript.segments),
          job.transcript.segmentationConfidence,
          job.transcript.detectedSpeechCount,
          job.transcript.topic,
          job.transcript.topicInferred,
        )
        console.log(`[pipeline:${job.id}] Cached transcript for video ${job.videoId}`)
      } catch (cacheErr) {
        console.warn(`[pipeline:${job.id}] Failed to cache transcript:`, cacheErr instanceof Error ? cacheErr.message : cacheErr)
      }
    }

    // Step 2: Flow
    const cachedFlow = (resumeFrom !== 'transcript' && resumeFrom !== 'diarize' && resumeFrom !== 'flow') ? getCachedFlow(job.videoId, job.transcript.topic) : null
    if (cachedFlow) {
      console.log(`[pipeline:${job.id}] Cache hit for flow`)
      job.flow = JSON.parse(cachedFlow.flow)
    }

    if (!job.flow) {
      job.status = 'flow'
      console.log(`[pipeline:${job.id}] Generating flow...`)
      job.flow = await generateFlowSheet(job.transcript.segments)

      // Cache flow
      try {
        saveFlowCache(job.videoId, job.transcript.topic, JSON.stringify(job.flow))
        console.log(`[pipeline:${job.id}] Cached flow for video ${job.videoId}`)
      } catch (cacheErr) {
        console.warn(`[pipeline:${job.id}] Failed to cache flow:`, cacheErr instanceof Error ? cacheErr.message : cacheErr)
      }
    }

    // Step 3: Judge
    const cachedJudge = (!resumeFrom || resumeFrom === 'judge') ? getCachedJudge(job.videoId, job.transcript.topic, job.paradigmId) : null
    if (cachedJudge) {
      console.log(`[pipeline:${job.id}] Cache hit for judge`)
      job.judging = JSON.parse(cachedJudge.result)
    }

    if (!job.judging) {
      job.status = 'judge'
      console.log(`[pipeline:${job.id}] Judging round with paradigm "${job.paradigmId}"...`)
      job.judging = await judgeRound(job.flow, job.transcript.topic, paradigmPrompt)

      // Cache judge result
      try {
        saveJudgeCache(job.videoId, job.transcript.topic, job.paradigmId, JSON.stringify(job.judging))
        console.log(`[pipeline:${job.id}] Cached judge result for video ${job.videoId}`)
      } catch (cacheErr) {
        console.warn(`[pipeline:${job.id}] Failed to cache judge result:`, cacheErr instanceof Error ? cacheErr.message : cacheErr)
      }
    }

    job.status = 'done'
    console.log(`[pipeline:${job.id}] Complete! Winner: ${job.judging.winner}`)
  } catch (err) {
    const stepLabel = job.status === 'transcript' ? 'Transcript'
      : job.status === 'diarize' ? 'Diarize'
      : job.status === 'flow' ? 'Flow'
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
  const { url, topic, resumeFrom, paradigm } = req.body as { url?: string; topic?: string; resumeFrom?: string; paradigm?: string }

  if (!url || typeof url !== 'string' || url.length > MAX_URL_LENGTH) {
    return res.status(400).json({ error: 'Valid YouTube URL required' })
  }
  if (topic && typeof topic === 'string' && topic.length > MAX_TOPIC_LENGTH) {
    return res.status(400).json({ error: 'Topic is too long' })
  }

  const validResume = resumeFrom === 'transcript' || resumeFrom === 'diarize' || resumeFrom === 'flow' || resumeFrom === 'judge' ? resumeFrom : undefined
  const paradigmId = paradigm || BUILTIN_PARADIGMS[0].id

  // Validate paradigm exists
  const builtinExists = BUILTIN_PARADIGMS.some((p) => p.id === paradigmId)
  const customExists = !builtinExists && getCustomParadigm(paradigmId) !== null
  if (!builtinExists && !customExists) {
    return res.status(400).json({ error: `Unknown paradigm: ${paradigmId}` })
  }

  const videoId = extractVideoId(url)
  if (!videoId) {
    return res.status(400).json({ error: 'Could not extract video ID from URL' })
  }

  cleanupOldJobs()

  const id = randomUUID()
  const initialStatus = validResume === 'transcript' ? 'transcript'
    : validResume === 'diarize' ? 'diarize'
    : validResume === 'flow' ? 'flow'
    : validResume === 'judge' ? 'judge'
    : 'transcript'

  const job: PipelineJob = {
    id,
    status: initialStatus,
    url,
    topic: topic ?? '',
    videoId,
    paradigmId,
    transcript: null,
    flow: null,
    judging: null,
    error: null,
    errorStep: null,
    createdAt: Date.now(),
  }
  jobs.set(id, job)

  console.log(`[pipeline:${id}] Started for video ${videoId}${validResume ? ` (resume from ${validResume})` : ''}`)
  runPipeline(job, topic || undefined, validResume as ResumeFrom | undefined).catch((err) => {
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