/**
 * User feedback submission endpoint.
 *
 * POST /api/feedback — saves feedback (message + optional rating + video URL)
 * GET  /api/feedback — admin-only list of feedback (requires Bearer ADMIN_KEY)
 */

import { Router } from 'express'
import { saveFeedback, getFeedback, getFeedbackCount } from '../db.js'
import { requireClientId } from '../rateLimit.js'

const router = Router()

const MAX_MESSAGE_LENGTH = 2000
const ADMIN_KEY = process.env.ADMIN_KEY ?? ''

function getClientIdFromReq(req: { headers: Record<string, string | string[] | undefined> }): string {
  const id = req.headers['x-client-id']
  return typeof id === 'string' ? id : 'unknown'
}

router.post('/', requireClientId, (req, res) => {
  const { message, rating, videoUrl } = req.body as {
    message?: string
    rating?: number
    videoUrl?: string
  }

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Message is required' })
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: 'Message is too long' })
  }
  if (rating !== undefined && (typeof rating !== 'number' || rating < 1 || rating > 5)) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5' })
  }

  try {
    const clientId = getClientIdFromReq(req)
    const record = saveFeedback(clientId, message.trim(), rating, videoUrl)
    console.log(`[feedback] Saved feedback from ${clientId}: rating=${rating ?? 'none'}`)
    res.status(201).json({ id: record.id, created_at: record.created_at })
  } catch (err) {
    console.error('Feedback save error:', err)
    res.status(500).json({ error: 'Failed to save feedback' })
  }
})

// Admin endpoint to view feedback (requires admin key)
router.get('/', (req, res) => {
  const auth = req.headers.authorization
  if (!ADMIN_KEY || auth !== `Bearer ${ADMIN_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const records = getFeedback(100)
    const count = getFeedbackCount()
    res.json({ count, records })
  } catch (err) {
    console.error('Feedback fetch error:', err)
    res.status(500).json({ error: 'Failed to fetch feedback' })
  }
})

export default router