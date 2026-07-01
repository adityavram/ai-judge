import { useState } from 'react'
import './UrlInput.css'

interface UrlInputProps {
  onSubmit: (url: string, topic: string) => void
  loading: boolean
}

export function UrlInput({ onSubmit, loading }: UrlInputProps) {
  const [url, setUrl] = useState('')
  const [topic, setTopic] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (url.trim()) onSubmit(url.trim(), topic.trim())
  }

  return (
    <form className="url-input" onSubmit={handleSubmit}>
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
        placeholder="Debate topic (optional — will be inferred)"
        disabled={loading}
      />
      <button type="submit" disabled={loading || !url.trim()}>
        {loading ? 'Processing...' : 'Judge Round'}
      </button>
    </form>
  )
}