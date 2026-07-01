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
      setErrors((prev) => [...prev, { step: 'transcript', message: err instanceof Error ? err.message : 'unknown' }])
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
      setErrors((prev) => [...prev, { step: 'flow', message: err instanceof Error ? err.message : 'unknown' }])
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
      setErrors((prev) => [...prev, { step: 'judge', message: err instanceof Error ? err.message : 'unknown' }])
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
            <strong>{err.step}:</strong> {err.message}
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