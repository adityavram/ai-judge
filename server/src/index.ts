import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import transcriptRouter from './routes/transcript.js'
import flowRouter from './routes/flow.js'
import judgeRouter from './routes/judge.js'
import feedbackRouter from './routes/feedback.js'
import { rateLimit, requireClientId } from './rateLimit.js'

const app = express()
const PORT = process.env.PORT ?? 3001

app.use(cors())
app.use(express.json({ limit: '10mb' }))

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// transcript endpoint: increments rate limit (counts as a "round")
app.use('/api/transcript', rateLimit, transcriptRouter)
// flow + judge endpoints: just validate client ID, don't increment
app.use('/api/flow', requireClientId, flowRouter)
app.use('/api/judge', requireClientId, judgeRouter)
app.use('/api/feedback', feedbackRouter)

app.listen(PORT, () => {
  console.log(`AI Judge server running on http://localhost:${PORT}`)
})