import { useState, useEffect } from 'react'
import { listCachedRounds, getCachedRound, type CachedRoundSummary } from '../api/client'
import type { Transcript, FlowSheet, JudgingResult } from '../api/client'
import './HistoryPanel.css'

interface HistoryPanelProps {
  onSelect: (videoId: string, topic: string, transcript: Transcript | null, flow: FlowSheet | null, judging: JudgingResult | null) => void
}

export function HistoryPanel({ onSelect }: HistoryPanelProps) {
  const [rounds, setRounds] = useState<CachedRoundSummary[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open && rounds.length === 0) {
      setLoading(true)
      listCachedRounds()
        .then(setRounds)
        .catch(() => setRounds([]))
        .finally(() => setLoading(false))
    }
  }, [open])

  const handleSelect = async (videoId: string) => {
    setLoading(true)
    try {
      const detail = await getCachedRound(videoId)
      if (detail) {
        onSelect(videoId, detail.topic, detail.transcript, detail.flow, detail.judging)
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

  return (
    <div className="history-panel">
      <button className="history-toggle" onClick={() => setOpen(!open)}>
        {open ? 'Hide History' : 'Cached Rounds'}
      </button>
      {open && (
        <div className="history-dropdown">
          {loading && rounds.length === 0 && <div className="history-empty">Loading...</div>}
          {!loading && rounds.length === 0 && <div className="history-empty">No cached rounds yet</div>}
          {rounds.map((round) => (
            <button
              key={round.videoId}
              className="history-item"
              onClick={() => handleSelect(round.videoId)}
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