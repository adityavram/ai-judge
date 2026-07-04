/**
 * AI Judge server entry point.
 *
 * Serves the built React client as static files in production,
 * and provides API routes for the pipeline, feedback, and cache.
 * All debate processing is handled by the async pipeline at POST /api/pipeline.
 */

import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import pipelineRouter from './routes/pipeline.js'
import feedbackRouter from './routes/feedback.js'
import cacheRouter from './routes/cache.js'
import paradigmsRouter from './routes/paradigms.js'

// Prevent unhandled rejections from crashing the process
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[server] Unhandled exception:', err)
})

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = express()
const PORT = process.env.PORT ?? 3001

app.use(cors())
app.use(express.json({ limit: '10mb' }))

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// API routes
app.use('/api/pipeline', pipelineRouter)
app.use('/api/feedback', feedbackRouter)
app.use('/api/cache', cacheRouter)
app.use('/api/paradigms', paradigmsRouter)

// Serve built client in production
const clientDist = join(__dirname, '..', '..', 'client', 'dist')
if (existsSync(clientDist)) {
  app.use(express.static(clientDist))
  // SPA fallback: serve index.html for non-API routes
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next()
    res.sendFile(join(clientDist, 'index.html'))
  })
  console.log(`Serving client from ${clientDist}`)
}

app.listen(PORT, () => {
  console.log(`AI Judge server running on http://localhost:${PORT}`)
})