import type { Transcript } from '../api/client'
import './TranscriptView.css'

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

interface TranscriptViewProps {
  transcript: Transcript
}

export function TranscriptView({ transcript }: TranscriptViewProps) {
  return (
    <div className="transcript-view">
      <div className="transcript-header">
        <h2>Transcript</h2>
        <span className="video-id">Video ID: {transcript.videoId}</span>
      </div>
      <div className="transcript-segments">
        {transcript.segments.map((seg, i) => (
          <div key={i} className={`segment segment-${seg.speaker.toLowerCase()}`}>
            <div className="segment-meta">
              <span className="speaker-badge">{seg.speaker}</span>
              <span className="time-range">
                {formatTime(seg.startTime)} - {formatTime(seg.endTime)}
              </span>
            </div>
            <p className="segment-text">{seg.text}</p>
          </div>
        ))}
      </div>
    </div>
  )
}