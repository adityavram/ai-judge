/**
 * Renders the full judging decision:
 * - Winner banner (Gov=blue, Opp=red)
 * - RFD (weighing, comparison, why winner won, link-by-link)
 * - Collapsible sections: Speaker Scores, Weighing, Clash Verdicts, Devil's Advocate, Feedback
 */

import type { JudgingResult } from '../api/client'
import { Collapsible } from './Collapsible'
import './JudgeView.css'

interface JudgeViewProps {
  result: JudgingResult
}

export function JudgeView({ result }: JudgeViewProps) {
  const winnerSide = result.winner
  const winnerColor = winnerSide === 'Government' ? '#3b82f6' : '#ef4444'

  return (
    <div className="judge-view">
      <div className="decision-banner" style={{ borderColor: winnerColor }}>
        <span className="winner-label">Winner:</span>
        <span className="winner-side" style={{ color: winnerColor }}>{winnerSide}</span>
      </div>

      <section className="judge-section">
        <h3>Reason for Decision</h3>
        <div className="rfd-text">
          <div className="rfd-block">
            <strong>Weighing</strong>
            <p>{result.rfd.weighing}</p>
          </div>
          <div className="rfd-block">
            <strong>Why This Weighing Outweighs</strong>
            <p>{result.rfd.weighingComparison}</p>
          </div>
          <div className="rfd-block">
            <strong>Why {winnerSide} Won</strong>
            <p>{result.rfd.whyWinnerWon}</p>
          </div>
          <div className="rfd-block">
            <strong>Link-by-Link</strong>
            <p>{result.rfd.linkByLink}</p>
          </div>
        </div>
      </section>

      <Collapsible title="Speaker Scores & Ranks" defaultOpen={false}>
        <table className="speaks-table">
          <thead>
            <tr>
              <th>Speech</th>
              <th>Speaker</th>
              <th>Side</th>
              <th>Score</th>
              <th>Rank</th>
              <th>Justification</th>
            </tr>
          </thead>
          <tbody>
            {result.speakerScores.map((s, i) => (
              <tr key={i} className={`speaks-row side-${s.side.toLowerCase()}`}>
                <td>{s.speech}</td>
                <td>{s.speaker}</td>
                <td>{s.side}</td>
                <td className="score-cell">{s.score}</td>
                <td className="rank-cell">{s.rank}</td>
                <td className="justification-cell">{s.justification}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Collapsible>

      <Collapsible title="Weighing Analysis" defaultOpen={false}>
        <p className="framework">{result.weighing.overallFramework}</p>
        <div className="key-issues">
          {result.weighing.keyIssues.map((issue, i) => (
            <div key={i} className="key-issue">
              <span className="issue-name">{issue.name}</span>
              <span className="issue-importance">{issue.importance}</span>
              <p className="issue-why">{issue.whyItMatters}</p>
            </div>
          ))}
        </div>
      </Collapsible>

      <Collapsible title="Clash Verdicts" badge={`${result.clashVerdicts.length}`} defaultOpen={false}>
        {result.clashVerdicts.map((clash, i) => (
          <div key={i} className={`clash-verdict verdict-${clash.winner.toLowerCase()}`}>
            <div className="clash-header">
              <span className="clash-name">{clash.clashName}</span>
              <span className={`clash-winner winner-${clash.winner.toLowerCase()}`}>{clash.winner}</span>
            </div>
            <p className="clash-reasoning">{clash.reasoning}</p>
            <div className="key-args">
              {clash.keyArgs.map((arg, j) => (
                <span key={j} className="key-arg">{arg}</span>
              ))}
            </div>
          </div>
        ))}
      </Collapsible>

      <Collapsible title="Devil's Advocate" badge={`${result.devilsAdvocatePositions.length}`} defaultOpen={false}>
        {result.devilsAdvocatePositions.map((pos, i) => (
          <div key={i} className="da-position">
            <div className="da-label">{pos.label}</div>
            <p className="da-argument">{pos.argument}</p>
            <p className="da-why"><strong>Why it could win:</strong> {pos.whyItCouldWin}</p>
          </div>
        ))}
      </Collapsible>

      <Collapsible title="Feedback" defaultOpen={false}>
        <div className="feedback-grid">
          <div className="feedback-card feedback-government">
            <h4>Government</h4>
            <div className="feedback-section">
              <strong>Strengths</strong>
              <ul>{result.governmentTeam.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
            <div className="feedback-section">
              <strong>Weaknesses</strong>
              <ul>{result.governmentTeam.weaknesses.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
            <div className="feedback-section">
              <strong>Improvements</strong>
              <ul>{result.governmentTeam.improvements.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
          </div>
          <div className="feedback-card feedback-opposition">
            <h4>Opposition</h4>
            <div className="feedback-section">
              <strong>Strengths</strong>
              <ul>{result.oppositionTeam.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
            <div className="feedback-section">
              <strong>Weaknesses</strong>
              <ul>{result.oppositionTeam.weaknesses.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
            <div className="feedback-section">
              <strong>Improvements</strong>
              <ul>{result.oppositionTeam.improvements.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
          </div>
        </div>
      </Collapsible>
    </div>
  )
}