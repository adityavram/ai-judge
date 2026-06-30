import { useState } from 'react'
import { UrlInput } from './components/UrlInput'
import { TranscriptView } from './components/TranscriptView'
import { fetchTranscript, type Transcript } from './api/client'
import './App.css'

function App() {
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleUrlSubmit = async (url: string) => {
    setLoading(true)
    setError(null)
    setTranscript(null)
    try {
      const result = await fetchTranscript(url)
      setTranscript(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>AI Judge</h1>
        <p>Upload a debate round and get an AI-generated decision</p>
      </header>

      <main className="app-main">
        <UrlInput onSubmit={handleUrlSubmit} loading={loading} />

        {error && (
          <div className="error-message">
            <strong>Error:</strong> {error}
          </div>
        )}

        {loading && (
          <div className="loading-message">
            Fetching transcript from YouTube...
          </div>
        )}

        {transcript && <TranscriptView transcript={transcript} />}
      </main>
    </div>
  )
}

export default App