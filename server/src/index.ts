import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import transcriptRouter from './routes/transcript.js'
import flowRouter from './routes/flow.js'
import judgeRouter from './routes/judge.js'
import feedbackRouter from './routes/feedback.js'
import { rateLimit, requireClientId } from './rateLimit.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = express()
const PORT = process.env.PORT ?? 3001

app.use(cors())
app.use(express.json({ limit: '10mb' }))

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// API routes
app.use('/api/transcript', rateLimit, transcriptRouter)
app.use('/api/flow', requireClientId, flowRouter)
app.use('/api/judge', requireClientId, judgeRouter)
app.use('/api/feedback', feedbackRouter)

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