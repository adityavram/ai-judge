import { useState } from 'react'
import { UrlInput } from './components/UrlInput'
import { Collapsible } from './components/Collapsible'
import { ProgressPipeline, type PipelineStep } from './components/ProgressPipeline'
import { TranscriptView } from './components/TranscriptView'
import { FlowView } from './components/FlowView'
import { JudgeView } from './components/JudgeView'
import { FeedbackButton } from './components/FeedbackButton'
import { startPipeline, pollPipeline, submitFeedback, type PipelineState } from './api/client'
import type { Transcript, FlowSheet, JudgingResult } from './api/client'
import './App.css'

function friendlyError(state: PipelineState): string {
  const raw = state.error ?? 'Unknown error'

  if (raw.includes('Daily round limit') || raw.includes('429')) {
    return "You've reached your daily limit of judged rounds. Please try again tomorrow."
  }
  if (raw.includes('daily') && raw.includes('limit') || raw.includes('token_exhausted')) {
    return 'The AI service has reached its daily usage limit. Please try again tomorrow.'
  }
  if (raw.includes('not properly configured') || raw.includes('invalid or not authorized')) {
    return 'The server is not properly configured. Please contact the administrator.'
  }
  if (raw.includes('timed out') || raw.includes('timeout') || raw.includes('504')) {
    return 'The AI took too long to process this round. Please try again — shorter videos may process faster.'
  }
  if (raw.includes('unavailable') || raw.includes('503') || raw.includes('502')) {
    return 'The AI service is temporarily unavailable. Please try again in a moment.'
  }
  if (raw.includes('Network error') || raw.includes('fetch failed')) {
    return 'Could not reach the server. Please check your connection and try again.'
  }

  const step = state.errorStep ?? ''
  if (step === 'Transcript') {
    if (raw.includes('No transcript')) return 'This video does not have captions/transcript available. Try a different video.'
    if (raw.includes('Could not extract video ID')) return 'That does not look like a valid YouTube URL. Please check and try again.'
    return `Failed to process the video transcript. ${raw}`
  }
  if (step === 'Flow Sheet') {
    if (raw.includes('All speeches failed')) return 'Could not analyze any of the speeches. The video may be too long or the captions too unclear.'
    return `Failed to generate the flow sheet. ${raw}`
  }
  if (step === 'Judging') {
    return `Failed to judge the round. ${raw}`
  }
  return raw
}

function App() {
  const [pipelineStep, setPipelineStep] = useState<PipelineStep>('idle')
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [flow, setFlow] = useState<FlowSheet | null>(null)
  const [judging, setJudging] = useState<JudgingResult | null>(null)
  const [errors, setErrors] = useState<{ step: string; message: string }[]>([])
  const [lastUrl, setLastUrl] = useState('')

  const runPipeline = async (url: string, topic: string) => {
    setLastUrl(url)
    setPipelineStep('transcript')
    setTranscript(null)
    setFlow(null)
    setJudging(null)
    setErrors([])

    try {
      const jobId = await startPipeline(url, topic || undefined)

      while (true) {
        const state = await pollPipeline(jobId)

        // Update step indicator
        if (state.status === 'transcript') setPipelineStep('transcript')
        else if (state.status === 'flow') setPipelineStep('flow')
        else if (state.status === 'judge') setPipelineStep('judge')
        else if (state.status === 'done') {
          setPipelineStep('done')
        } else if (state.status === 'error') {
          setPipelineStep('error')
        }

        // Show partial results as they arrive
        if (state.transcript) setTranscript(state.transcript)
        if (state.flow) setFlow(state.flow)
        if (state.judging) setJudging(state.judging)

        if (state.status === 'error') {
          setErrors([{ step: state.errorStep ?? 'Error', message: friendlyError(state) }])
          return
        }

        if (state.status === 'done') return
      }
    } catch (err) {
      setErrors([{ step: 'Pipeline', message: err instanceof Error ? err.message : 'Unknown error' }])
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