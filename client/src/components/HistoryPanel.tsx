/**
 * Dropdown panel that lists cached rounds from the server.
 * Clicking a round instantly loads transcript/flow/judging from cache
 * without re-running the pipeline.
 */

import { useState, useEffect } from 'react'
import { listCachedRounds, getCachedRound, type CachedRoundSummary, type DebateFormat } from '../api/client'
import type { Transcript, AnyFlowSheet, AnyJudgingResult } from '../api/client'
import './HistoryPanel.css'

interface HistoryPanelProps {
  onSelect: (videoId: string, topic: string, transcript: Transcript | null, flow: AnyFlowSheet | null, judging: AnyJudgingResult | null, format?: DebateFormat) => void
  paradigmId: string
  format: DebateFormat
}

export function HistoryPanel({ onSelect, paradigmId, format }: HistoryPanelProps) {
  const [rounds, setRounds] = useState<CachedRoundSummary[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) {
      setLoading(true)
      listCachedRounds()
        .then(setRounds)
        .catch(() => setRounds([]))
        .finally(() => setLoading(false))
    }
  }, [open, format])

  const handleSelect = async (videoId: string, roundFormat: DebateFormat) => {
    setLoading(true)
    try {
      const detail = await getCachedRound(videoId, paradigmId, roundFormat)
      if (detail) {
        onSelect(videoId, detail.topic, detail.transcript, detail.flow, detail.judging, detail.format)
        setOpen(false)
      }
    } finally {
      setLoading(false)
    }
  }

  const formatDate = (iso: string) => {
    try {
      return new Date(iso + 'Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    } catch {
      return iso
    }
  }

  const formatLabel = (f: string) => f === 'bp' ? 'British Parliamentary' : 'American Parliamentary'

  const filteredRounds = rounds.filter((r) => r.format === format)

  return (
    <div className="history-panel">
      <button className="history-toggle" onClick={() => setOpen(!open)}>
        {open ? 'Hide History' : 'Cached Rounds'}
      </button>
      {open && (
        <div className="history-dropdown">
          {loading && rounds.length === 0 && <div className="history-empty">Loading...</div>}
          {!loading && filteredRounds.length === 0 && <div className="history-empty">No {formatLabel(format)} rounds yet</div>}
          {filteredRounds.map((round) => (
            <button
              key={round.videoId}
              className="history-item"
              onClick={() => handleSelect(round.videoId, round.format)}
              disabled={loading}
            >
              <div className="history-topic">{round.topic}</div>
              <div className="history-meta">
                <span className="history-video-id">{round.videoId}</span>
                <span className="history-date">{formatDate(round.createdAt)}</span>
                <span className="history-badges">
                  {round.hasJudge && <span className="badge badge-judge">Judged</span>}
                  {round.hasFlow && !round.hasJudge && <span className="badge badge-flow">Flow</span>}
                  {!round.hasFlow && !round.hasJudge && <span className="badge badge-transcript">Transcript</span>}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}