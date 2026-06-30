import { useState } from 'react'
import './UrlInput.css'

interface UrlInputProps {
  onSubmit: (url: string) => void
  loading: boolean
}

export function UrlInput({ onSubmit, loading }: UrlInputProps) {
  const [url, setUrl] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (url.trim()) onSubmit(url.trim())
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
      <button type="submit" disabled={loading || !url.trim()}>
        {loading ? 'Processing...' : 'Judge Round'}
      </button>
    </form>
  )
}