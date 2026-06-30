import express from 'express'
import cors from 'cors'
import transcriptRouter from './routes/transcript.js'

const app = express()
const PORT = process.env.PORT ?? 3001

app.use(cors())
app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.use('/api/transcript', transcriptRouter)

app.listen(PORT, () => {
  console.log(`AI Judge server running on http://localhost:${PORT}`)
})