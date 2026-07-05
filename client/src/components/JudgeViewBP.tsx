import type { BPJudgingResult } from '../api/client'
import { Collapsible } from './Collapsible'
import './JudgeViewBP.css'

const TEAM_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  OG: { bg: 'rgba(59,130,246,0.08)', border: '#3b82f6', text: '#3b82f6' },
  OO: { bg: 'rgba(239,68,68,0.08)', border: '#ef4444', text: '#ef4444' },
  CG: { bg: 'rgba(6,182,212,0.08)', border: '#06b6d4', text: '#06b6d4' },
  CO: { bg: 'rgba(245,158,11,0.08)', border: '#f59e0b', text: '#f59e0b' },
}

const RANK_LABELS = ['1st', '2nd', '3rd', '4th'] as const

interface JudgeViewBPProps {
  result: BPJudgingResult
}

export function JudgeViewBP({ result }: JudgeViewBPProps) {
  const sortedRankings = [...result.rankings].sort((a, b) => a.rank - b.rank)
  const teamKeys = ['OG', 'OO', 'CG', 'CO'] as const

  return (
    <div className="judge-view-bp">
      <div className="bp-experimental-banner">
        <span className="bp-experimental-icon">&#9888;&#65039;</span>
        <span>British Parliamentary judging is <strong>experimental</strong> and may produce inaccurate rankings or feedback. Use with caution.</span>
      </div>
      <div className="bp-rankings-grid">
        {sortedRankings.map((r) => {
          const c = TEAM_COLORS[r.team] ?? TEAM_COLORS.OG
          return (
            <div
              key={r.team}
              className="bp-ranking-card"
              style={{ borderLeftColor: c.border, background: c.bg }}
            >
              <div className="bp-ranking-header">
                <span className="bp-ranking-place" style={{ color: c.text }}>
                  {RANK_LABELS[r.rank - 1]}
                </span>
                <span className="bp-ranking-team" style={{ color: c.text }}>
                  {r.team}
                </span>
              </div>
              <p className="bp-ranking-reasoning">{r.reasoning}</p>
            </div>
          )
        })}
      </div>

      <section className="judge-section">
        <h3>Reason for Decision</h3>
        <div className="rfd-text">
          <div className="rfd-block">
            <strong>Opening Half — OG vs OO</strong>
            <p>{result.rfd.topHalfSummary}</p>
          </div>
          <div className="rfd-block">
            <strong>Top Half Winner: {result.rfd.topHalfWinner}</strong>
            <p>{result.rfd.topHalfReasoning}</p>
          </div>
          <div className="rfd-block">
            <strong>Closing Government (CG)</strong>
            <p>{result.rfd.closingGovernment}</p>
          </div>
          <div className="rfd-block">
            <strong>Closing Opposition (CO)</strong>
            <p>{result.rfd.closingOpposition}</p>
          </div>
          <div className="rfd-block">
            <strong>Final Ranking</strong>
            <p>{result.rfd.finalRankingJustification}</p>
          </div>
        </div>
      </section>

      <Collapsible title="Speaker Scores & Ranks" defaultOpen={false}>
        <table className="speaks-table bp-speaks-table">
          <thead>
            <tr>
              <th>Speech</th>
              <th>Speaker</th>
              <th>Team</th>
              <th>Score</th>
              <th>Rank</th>
              <th>Justification</th>
            </tr>
          </thead>
          <tbody>
            {result.speakerScores.map((s, i) => {
              const c = TEAM_COLORS[s.team] ?? TEAM_COLORS.OG
              return (
                <tr key={i} className="speaks-row" style={{ background: c.bg }}>
                  <td>{s.speech}</td>
                  <td>{s.speaker}</td>
                  <td style={{ color: c.text, fontWeight: 600 }}>{s.team}</td>
                  <td className="score-cell">{s.score}</td>
                  <td className="rank-cell">{s.rank}</td>
                  <td className="justification-cell">{s.justification}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Collapsible>

      <Collapsible title="Per-Team Feedback" defaultOpen={false}>
        <div className="bp-feedback-grid">
          {teamKeys.map((key) => {
            const team = result.teams[key]
            if (!team) return null
            const c = TEAM_COLORS[key]
            return (
              <div
                key={key}
                className="feedback-card"
                style={{ borderLeftColor: c.border }}
              >
                <h4 style={{ color: c.text }}>{key} — {team.side}</h4>
                <div className="feedback-section">
                  <strong>Strengths</strong>
                  <ul>{team.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
                </div>
                <div className="feedback-section">
                  <strong>Weaknesses</strong>
                  <ul>{team.weaknesses.map((s, i) => <li key={i}>{s}</li>)}</ul>
                </div>
                <div className="feedback-section">
                  <strong>Improvements</strong>
                  <ul>{team.improvements.map((s, i) => <li key={i}>{s}</li>)}</ul>
                </div>
              </div>
            )
          })}
        </div>
      </Collapsible>

      <Collapsible
        title="Devil's Advocate"
        badge={`${result.devilsAdvocatePositions.length}`}
        defaultOpen={false}
      >
        {result.devilsAdvocatePositions.map((pos, i) => {
          const c = TEAM_COLORS[pos.team] ?? TEAM_COLORS.OG
          return (
            <div
              key={i}
              className="da-position"
              style={{ borderLeftColor: c.border }}
            >
              <div className="da-label" style={{ color: c.text }}>
                {pos.label} <span style={{ fontWeight: 400 }}>({pos.team})</span>
              </div>
              <p className="da-argument">{pos.argument}</p>
              <p className="da-why">
                <strong>Why it could win:</strong> {pos.whyItCouldWin}
              </p>
            </div>
          )
        })}
      </Collapsible>
    </div>
  )
}