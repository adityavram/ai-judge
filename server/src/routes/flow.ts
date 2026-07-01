import { Router } from 'express'
import { generateFlowSheet } from '../flow.js'
import { LlmError, llmErrorToResponse } from '../llm.js'
import type { SpeakerSegment, FlowSheet } from '../types.js'

const router = Router()

const MAX_SEGMENTS = 20

router.post('/', async (req, res) => {
  const { segments } = req.body as { segments?: SpeakerSegment[] }

  if (!segments || !Array.isArray(segments) || segments.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid "segments" in request body' })
  }
  if (segments.length > MAX_SEGMENTS) {
    return res.status(400).json({ error: `Too many segments (max ${MAX_SEGMENTS})` })
  }

  try {
    const flowSheet = await generateFlowSheet(segments)
    console.log(`[flow] Generated: ${flowSheet.clashes.length} clashes from ${segments.length} speeches`)
    res.json(flowSheet satisfies FlowSheet)
  } catch (err) {
    if (err instanceof LlmError) {
      console.error('[flow] LLM error:', err.kind, err.message)
      const { error, detail } = llmErrorToResponse(err)
      return res.status(err.statusCode).json({ error, detail })
    }
    console.error('Flow generation error:', err)
    res.status(500).json({
      error: 'Failed to generate flow sheet',
      detail: err instanceof Error ? err.message : 'Unknown error',
    })
  }
})

export default router