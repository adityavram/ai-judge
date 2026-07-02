import { useState } from 'react'
import { UrlInput } from './components/UrlInput'
import { Collapsible } from './components/Collapsible'
import { ProgressPipeline, type PipelineStep } from './components/ProgressPipeline'
import { TranscriptView } from './components/TranscriptView'
import { FlowView } from './components/FlowView'
import { JudgeView } from './components/JudgeView'
import { FeedbackButton } from './components/FeedbackButton'
import { fetchTranscript, fetchFlow, judgeRound, submitFeedback, type Transcript, type FlowSheet, type JudgingResult } from './api/client'
import './App.css'

function App() {
  const [pipelineStep, setPipelineStep] = useState<PipelineStep>('idle')
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [flow, setFlow] = useState<FlowSheet | null>(null)
  const [judging, setJudging] = useState<JudgingResult | null>(null)
  const [errors, setErrors] = useState<{ step: string; message: string }[]>([])
  const [lastUrl, setLastUrl] = useState('')

  function friendlyError(step: string, err: unknown): string {
    const raw = err instanceof Error ? err.message : 'unknown'

    // Network errors
    if (raw.includes('Network error') || raw.includes('fetch failed')) {
      return 'Could not reach the server. Please check your connection and try again.'
    }
    // Rate limit
    if (raw.includes('Daily round limit') || raw.includes('429')) {
      return "You've reached your daily limit of judged rounds. Please try again tomorrow."
    }
    // Token exhaustion
    if (raw.includes('daily') && raw.includes('limit') || raw.includes('token_exhausted')) {
      return 'The AI service has reached its daily usage limit. Please try again tomorrow.'
    }
    // Config errors
    if (raw.includes('not properly configured') || raw.includes('invalid or not authorized')) {
      return 'The server is not properly configured. Please contact the administrator.'
    }
    // Timeout
    if (raw.includes('timed out') || raw.includes('timeout') || raw.includes('504')) {
      return 'The AI took too long to process this round. Please try again — shorter videos may process faster.'
    }
    // Provider unavailable
    if (raw.includes('unavailable') || raw.includes('503') || raw.includes('502')) {
      return 'The AI service is temporarily unavailable. Please try again in a moment.'
    }
    // Step-specific
    if (step === 'transcript') {
      if (raw.includes('No transcript')) return 'This video does not have captions/transcript available. Try a different video.'
      if (raw.includes('Could not extract video ID')) return 'That does not look like a valid YouTube URL. Please check and try again.'
      return `Failed to process the video transcript. ${raw}`
    }
    if (step === 'flow') {
      if (raw.includes('All speeches failed')) return 'Could not analyze any of the speeches. The video may be too long or the captions too unclear.'
      return `Failed to generate the flow sheet. ${raw}`
    }
    if (step === 'judge') {
      return `Failed to judge the round. ${raw}`
    }
    return raw
  }

  const runPipeline = async (url: string, topic: string) => {
    setLastUrl(url)
    setPipelineStep('transcript')
    setTranscript(null)
    setFlow(null)
    setJudging(null)
    setErrors([])

    // Step 1: Transcript
    let currentTranscript: Transcript
    try {
      currentTranscript = await fetchTranscript(url, topic)
      setTranscript(currentTranscript)
    } catch (err) {
      setErrors((prev) => [...prev, { step: 'Transcript', message: friendlyError('transcript', err) }])
      setPipelineStep('error')
      return
    }

    // Step 2: Flow
    setPipelineStep('flow')
    let currentFlow: FlowSheet
    try {
      currentFlow = await fetchFlow(currentTranscript.segments)
      setFlow(currentFlow)
    } catch (err) {
      setErrors((prev) => [...prev, { step: 'Flow Sheet', message: friendlyError('flow', err) }])
      setPipelineStep('error')
      return
    }

    // Step 3: Judge
    setPipelineStep('judge')
    try {
      const result = await judgeRound(currentFlow, currentTranscript.topic)
      setJudging(result)
      setPipelineStep('done')
    } catch (err) {
      setErrors((prev) => [...prev, { step: 'Judging', message: friendlyError('judge', err) }])
      setPipelineStep('error')
    }
  }

  const handleFeedback = async (message: string, rating: number) => {
    await submitFeedback(message, rating || undefined, lastUrl || undefined)
  }

  const busy = pipelineStep !== 'idle' && pipelineStep !== 'done' && pipelineStep !== 'error'

  return (
    <div className="app">
      <FeedbackButton onSubmit={handleFeedback} />
      <header className="app-header">
        <h1>AI Judge</h1>
        <p>Enter a debate round URL to get an AI-generated decision</p>
      </header>

      <main className="app-main">
        <UrlInput onSubmit={runPipeline} loading={busy} />

        {pipelineStep !== 'idle' && (
          <ProgressPipeline currentStep={pipelineStep} errors={errors} />
        )}

        {errors.map((err, i) => (
          <div key={i} className="error-message">
            <div className="error-step">{err.step} Error</div>
            <div className="error-detail">{err.message}</div>
          </div>
        ))}

        {pipelineStep === 'done' && judging && (
          <>
            <JudgeView result={judging} />
            <div className="section-divider" />
          </>
        )}

        {transcript && pipelineStep !== 'idle' && (
          <Collapsible title="Transcript" badge={`${transcript.segments.length} speeches`} defaultOpen={false}>
            <TranscriptView transcript={transcript} />
          </Collapsible>
        )}

        {flow && pipelineStep !== 'idle' && (
          <Collapsible title="Flow Sheet" badge={`${flow.clashes.length} clashes`} defaultOpen={false}>
            <FlowView flow={flow} />
          </Collapsible>
        )}
      </main>
    </div>
  )
}

export default App