/**
 * Floating feedback button that opens a modal with star rating + text area.
 * Submits to POST /api/feedback.
 */

import { useState } from 'react'
import './FeedbackButton.css'

interface FeedbackButtonProps {
  onSubmit: (message: string, rating: number, videoUrl?: string) => Promise<void>
}

export function FeedbackButton({ onSubmit }: FeedbackButtonProps) {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [rating, setRating] = useState(0)
  const [hoverRating, setHoverRating] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    if (!message.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(message.trim(), rating || 0)
      setSubmitted(true)
      setTimeout(() => {
        setOpen(false)
        setSubmitted(false)
        setMessage('')
        setRating(0)
      }, 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <button className="feedback-button" onClick={() => setOpen(true)}>
        Feedback
      </button>

      {open && (
        <div className="feedback-overlay" onClick={() => !submitting && setOpen(false)}>
          <div className="feedback-modal" onClick={(e) => e.stopPropagation()}>
            {submitted ? (
              <div className="feedback-success">
                <span className="success-check">{'\u2713'}</span>
                <p>Thank you for your feedback!</p>
              </div>
            ) : (
              <>
                <div className="feedback-header">
                  <h3>Send Feedback</h3>
                  <button className="feedback-close" onClick={() => setOpen(false)}>{'\u2715'}</button>
                </div>

                <div className="feedback-rating">
                  <span className="rating-label">How was your experience?</span>
                  <div className="rating-stars">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        className={`star ${(hoverRating || rating) >= n ? 'active' : ''}`}
                        onClick={() => setRating(n)}
                        onMouseEnter={() => setHoverRating(n)}
                        onMouseLeave={() => setHoverRating(0)}
                      >
                        {'\u2605'}
                      </button>
                    ))}
                  </div>
                </div>

                <textarea
                  className="feedback-text"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Tell us what you think — bugs, feature requests, wrong decisions, etc."
                  rows={5}
                  maxLength={2000}
                  disabled={submitting}
                />

                {error && <div className="feedback-error">{error}</div>}

                <div className="feedback-actions">
                  <button className="feedback-cancel" onClick={() => setOpen(false)} disabled={submitting}>
                    Cancel
                  </button>
                  <button
                    className="feedback-submit"
                    onClick={handleSubmit}
                    disabled={submitting || !message.trim()}
                  >
                    {submitting ? 'Sending...' : 'Submit'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}