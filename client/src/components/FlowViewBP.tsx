import type { BPFlowSheet, BPFlowEntry, BPFlowArg } from '../api/client'
import { BP_SPEECHES } from '../api/client'
import './FlowViewBP.css'

interface FlowViewBPProps {
  flow: BPFlowSheet
}

const TEAM_META: Record<string, { label: string; color: string; side: string }> = {
  OG: { label: 'Opening Government', color: 'og', side: 'Government' },
  OO: { label: 'Opening Opposition', color: 'oo', side: 'Opposition' },
  CG: { label: 'Closing Government', color: 'cg', side: 'Government' },
  CO: { label: 'Closing Opposition', color: 'co', side: 'Opposition' },
}

function ArgCard({ arg }: { arg: BPFlowArg }) {
  return (
    <div className="bp-arg">
      <div className="bp-arg-tag">{arg.tag}</div>
      {arg.text && <div className="bp-arg-text">{arg.text}</div>}
      {arg.components.map((comp, i) => (
        <div key={i} className="bp-arg-component">
          <span className="bp-comp-label">{comp.label}</span>
          <span className="bp-comp-text">{comp.text}</span>
        </div>
      ))}
      {arg.isExtension && <span className="bp-badge bp-badge-extension">Extension</span>}
      {arg.respondsTo && <div className="bp-responds-to">Responds to: {arg.respondsTo}</div>}
      {arg.isNewInWhip && <span className="bp-badge bp-badge-whip-warning">New in Whip</span>}
    </div>
  )
}

function SpeechCard({ entry }: { entry: BPFlowEntry }) {
  const meta = BP_SPEECHES.find((s) => s.label === entry.speech)
  const teamMeta = TEAM_META[entry.team] ?? TEAM_META[entry.speech.startsWith('P') || entry.speech.startsWith('D') || entry.speech === 'GW' ? (entry.side === 'Government' ? 'OG' : 'OO') : (entry.side === 'Government' ? 'CG' : 'CO')]
  const color = teamMeta?.color ?? entry.team?.toLowerCase() ?? 'og'
  const hasNewInWhip = entry.args.some((a) => a.isNewInWhip)

  return (
    <div className={`bp-speech-card bp-team-${color}`}>
      <div className="bp-speech-header">
        <div className="bp-speech-label-row">
          <span className="bp-speech-name">{entry.speech}</span>
          <span className={`bp-team-badge bp-team-badge-${color}`}>{entry.team}</span>
          <span className={`bp-side-badge bp-side-${(entry.side ?? meta?.side ?? 'Government').toLowerCase()}`}>
            {entry.side ?? meta?.side ?? ''}
          </span>
        </div>
        {entry.isExtension && <span className="bp-badge bp-badge-extension bp-badge-header">Extension Speech</span>}
      </div>

      {entry.knifeDetected && (
        <div className="bp-knife-warning">
          <span className="bp-knife-icon">&#x2694;&#xFE0F;</span>
          <span>Knife detected</span>
          {entry.knifeExplanation && <div className="bp-knife-explanation">{entry.knifeExplanation}</div>}
        </div>
      )}

      {hasNewInWhip && (
        <div className="bp-whip-warning">
          <span className="bp-whip-icon">&#x26A0;</span>
          <span>New arguments introduced in whip</span>
        </div>
      )}

      {entry.extensionSummary && (
        <div className="bp-extension-summary">{entry.extensionSummary}</div>
      )}

      <div className="bp-args-list">
        {entry.args.map((arg, i) => (
          <ArgCard key={i} arg={arg} />
        ))}
      </div>
    </div>
  )
}

export function FlowViewBP({ flow }: FlowViewBPProps) {
  const ordered = flow.entries.slice().sort((a, b) => {
    const ai = BP_SPEECHES.findIndex((s) => s.label === a.speech)
    const bi = BP_SPEECHES.findIndex((s) => s.label === b.speech)
    return ai - bi
  })

  return (
    <div className="bp-flow-view">
      <h2>BP Flow</h2>
      <div className="bp-speeches-grid">
        {ordered.map((entry) => (
          <SpeechCard key={entry.speech} entry={entry} />
        ))}
      </div>
    </div>
  )
}