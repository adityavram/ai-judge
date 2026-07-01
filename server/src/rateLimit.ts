import type { Request, Response, NextFunction } from 'express'

const DAILY_LIMIT = parseInt(process.env.DAILY_ROUND_LIMIT ?? '5', 10)
const WINDOW_MS = 24 * 60 * 60 * 1000

interface UsageRecord {
  count: number
  windowStart: number
}

const usage = new Map<string, UsageRecord>()

function getClientId(req: Request): string | null {
  const clientId = req.headers['x-client-id']
  if (typeof clientId === 'string' && clientId.length > 0 && clientId.length < 100) {
    return clientId
  }
  return null
}

export interface RateLimitInfo {
  remaining: number
  limit: number
  resetAt: Date
}

export function getRateLimitInfo(clientId: string): RateLimitInfo {
  const now = Date.now()
  const record = usage.get(clientId)
  if (!record || now >= record.windowStart + WINDOW_MS) {
    return { remaining: DAILY_LIMIT, limit: DAILY_LIMIT, resetAt: new Date(now + WINDOW_MS) }
  }
  return { remaining: Math.max(0, DAILY_LIMIT - record.count), limit: DAILY_LIMIT, resetAt: new Date(record.windowStart + WINDOW_MS) }
}

// Middleware: requires X-Client-Id header, tracks usage per UUID
// Only counts a "round" once per pipeline run (tracked on transcript endpoint)
export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const clientId = getClientId(req)
  if (!clientId) {
    res.status(400).json({ error: 'Missing X-Client-Id header' })
    return
  }

  const now = Date.now()
  let record = usage.get(clientId)

  if (!record || now >= record.windowStart + WINDOW_MS) {
    record = { count: 0, windowStart: now }
    usage.set(clientId, record)
  }

  if (record.count >= DAILY_LIMIT) {
    const resetAt = new Date(record.windowStart + WINDOW_MS)
    res.status(429).json({
      error: 'Daily round limit reached',
      detail: `You've used all ${DAILY_LIMIT} rounds today. Resets at ${resetAt.toISOString()}.`,
      retryAfter: Math.ceil((record.windowStart + WINDOW_MS - now) / 1000),
    })
    return
  }

  // Increment usage
  record.count++

  res.setHeader('X-RateLimit-Limit', String(DAILY_LIMIT))
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, DAILY_LIMIT - record.count)))
  res.setHeader('X-RateLimit-Reset', new Date(record.windowStart + WINDOW_MS).toISOString())

  next()
}

// Middleware: just validates client ID exists, doesn't increment (for flow/judge endpoints)
export function requireClientId(req: Request, res: Response, next: NextFunction): void {
  const clientId = getClientId(req)
  if (!clientId) {
    res.status(400).json({ error: 'Missing X-Client-Id header' })
    return
  }
  next()
}