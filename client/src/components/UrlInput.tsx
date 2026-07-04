/**
 * URL input form with optional topic field and format toggle (APDA/BP).
 * Submits to App.runPipeline which starts the async pipeline.
 */

import { useState } from 'react'
import type { DebateFormat } from '../api/client'
import './UrlInput.css'

interface UrlInputProps {
  onSubmit: (url: string, topic: string) => void
  loading: boolean
  format: DebateFormat
  onFormatChange: (format: DebateFormat) => void
}

export function UrlInput({ onSubmit, loading, format, onFormatChange }: UrlInputProps) {
  const [url, setUrl] = useState('')
  const [topic, setTopic] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (url.trim()) onSubmit(url.trim(), topic.trim())
  }

  return (
    <form className="url-input" onSubmit={handleSubmit}>
      <div className="format-buttons">
        <button
          type="button"
          className={`format-btn ${format === 'apda' ? 'active' : ''}`}
          onClick={() => onFormatChange('apda')}
          disabled={loading}
        >
          American Parliamentary
        </button>
        <button
          type="button"
          className={`format-btn ${format === 'bp' ? 'active' : ''}`}
          onClick={() => onFormatChange('bp')}
          disabled={loading}
        >
          British Parliamentary
        </button>
      </div>
      <input
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Paste YouTube debate video URL..."
        disabled={loading}
        autoFocus
      />
      <input
        type="text"
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        placeholder={format === 'bp' ? 'Debate motion (optional — will be inferred)' : 'Debate topic (optional — will be inferred)'}
        disabled={loading}
      />
      <button type="submit" disabled={loading || !url.trim()}>
        {loading ? 'Processing...' : 'Judge Round'}
      </button>
    </form>
  )
}