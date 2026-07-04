/**
 * Paradigm management endpoints.
 *
 * GET  /api/paradigms           — list built-in + user's custom paradigms
 * POST /api/paradigms           — create a custom paradigm
 * DELETE /api/paradigms/:id     — delete a custom paradigm (only if owned by client)
 */

import { Router } from 'express'
import { requireClientId } from '../rateLimit.js'
import { getCustomParadigms, saveCustomParadigm, deleteCustomParadigm } from '../db.js'
import { BUILTIN_PARADIGMS } from '../paradigms.js'
import { randomUUID } from 'crypto'

const router = Router()

const MAX_NAME_LENGTH = 100
const MAX_PROMPT_LENGTH = 5000

function getClientId(req: { headers: Record<string, string | string[] | undefined> }): string {
  const id = req.headers['x-client-id']
  return typeof id === 'string' ? id : ''
}

router.get('/', requireClientId, (_req, res) => {
  const clientId = getClientId(_req)
  const custom = getCustomParadigms(clientId)
  res.json({
    builtin: BUILTIN_PARADIGMS,
    custom,
  })
})

router.post('/', requireClientId, (req, res) => {
  const clientId = getClientId(req)
  const { name, description, prompt } = req.body as { name?: string; description?: string; prompt?: string }

  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'Name is required' })
  }
  if (name.length > MAX_NAME_LENGTH) {
    return res.status(400).json({ error: `Name must be ${MAX_NAME_LENGTH} characters or less` })
  }
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return res.status(400).json({ error: 'Prompt is required' })
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return res.status(400).json({ error: `Prompt must be ${MAX_PROMPT_LENGTH} characters or less` })
  }

  const id = randomUUID()
  saveCustomParadigm(id, clientId, name.trim(), (description || '').trim(), prompt.trim())

  res.status(201).json({
    id,
    clientId,
    name: name.trim(),
    description: (description || '').trim(),
    prompt: prompt.trim(),
    isBuiltin: false,
  })
})

router.delete('/:id', requireClientId, (req, res) => {
  const clientId = getClientId(req)
  const id = req.params.id
  if (typeof id !== 'string') {
    return res.status(400).json({ error: 'Invalid paradigm ID' })
  }

  const deleted = deleteCustomParadigm(id, clientId)
  if (!deleted) {
    return res.status(404).json({ error: 'Paradigm not found or not owned by you' })
  }

  res.json({ ok: true })
})

export default router