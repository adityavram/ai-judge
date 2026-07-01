import { Router } from 'express'
import { judgeRound } from '../judge.js'
import { LlmError, llmErrorToResponse } from '../llm.js'
import type { FlowSheet } from '../types.js'

const router = Router()

const MAX_CLASHES = 20

router.post('/', async (req, res) => {
  const { flow, topic } = req.body as { flow?: FlowSheet; topic?: string }

  if (!flow || !flow.clashes || !Array.isArray(flow.clashes)) {
    return res.status(400).json({ error: 'Missing or invalid "flow" in request body' })
  }
  if (flow.clashes.length > MAX_CLASHES) {
    return res.status(400).json({ error: `Too many clashes (max ${MAX_CLASHES})` })
  }
  if (!topic || typeof topic !== 'string') {
    return res.status(400).json({ error: 'Missing "topic" in request body' })
  }

  try {
    console.log(`[judge] Judging round: ${flow.clashes.length} clashes, topic="${topic}"`)
    const result = await judgeRound(flow, topic)
    res.json(result)
  } catch (err) {
    if (err instanceof LlmError) {
      console.error('[judge] LLM error:', err.kind, err.message)
      const { error, detail } = llmErrorToResponse(err)
      return res.status(err.statusCode).json({ error, detail })
    }
    console.error('Judging error:', err)
    res.status(500).json({
      error: 'Failed to judge round',
      detail: err instanceof Error ? err.message : 'Unknown error',
    })
  }
})

export default router