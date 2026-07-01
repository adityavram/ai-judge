import './ProgressPipeline.css'

export type PipelineStep = 'idle' | 'transcript' | 'flow' | 'judge' | 'done' | 'error'

interface ProgressPipelineProps {
  currentStep: PipelineStep
  errors: { step: string; message: string }[]
}

const STEPS = [
  { key: 'transcript', label: 'Transcript', desc: 'Fetching YouTube captions & segmenting speeches' },
  { key: 'flow', label: 'Flow Sheet', desc: 'Extracting arguments & building clash structure' },
  { key: 'judge', label: 'Judging', desc: 'Weighing, evaluating clashes, devil\'s advocate, RFD' },
] as const

export function ProgressPipeline({ currentStep, errors }: ProgressPipelineProps) {
  const order: PipelineStep[] = ['idle', 'transcript', 'flow', 'judge', 'done']
  const currentIdx = order.indexOf(currentStep)

  return (
    <div className="progress-pipeline">
      {STEPS.map((step, i) => {
        const stepIdx = order.indexOf(step.key as PipelineStep)
        let status: 'pending' | 'active' | 'done' | 'error' = 'pending'
        if (currentStep === 'error' && errors.some((e) => e.step === step.key)) {
          status = 'error'
        } else if (stepIdx < currentIdx) {
          status = 'done'
        } else if (stepIdx === currentIdx) {
          status = 'active'
        }

        return (
          <div key={step.key} className={`pipeline-step ${status}`}>
            <div className="step-indicator">
              {status === 'done' && <span className="step-check">{'\u2713'}</span>}
              {status === 'active' && <span className="step-spinner" />}
              {status === 'error' && <span className="step-x">{'\u2715'}</span>}
              {status === 'pending' && <span className="step-num">{i + 1}</span>}
            </div>
            <div className="step-info">
              <div className="step-label">{step.label}</div>
              <div className="step-desc">{step.desc}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}