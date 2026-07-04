import { useState, useEffect } from 'react'
import { listParadigms, createParadigm, deleteParadigm, type ParadigmList } from '../api/client'
import './ParadigmSelector.css'

interface ParadigmSelectorProps {
  selected: string
  onSelect: (id: string) => void
}

export function ParadigmSelector({ selected, onSelect }: ParadigmSelectorProps) {
  const [paradigms, setParadigms] = useState<ParadigmList>({ builtin: [], custom: [] })
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editPrompt, setEditPrompt] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listParadigms()
      .then(setParadigms)
      .catch(() => setParadigms({ builtin: [], custom: [] }))
      .finally(() => setLoading(false))
  }, [])

  const allParadigms = [...paradigms.builtin, ...paradigms.custom]
  const selectedParadigm = allParadigms.find((p) => p.id === selected)

  const startCustom = () => {
    setEditing(true)
    setEditName('')
    setEditDesc('')
    setEditPrompt(paradigms.builtin[0]?.prompt ?? '')
    setError(null)
  }

  const handleSave = async () => {
    if (!editName.trim() || !editPrompt.trim()) {
      setError('Name and prompt are required')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const created = await createParadigm(editName.trim(), editDesc.trim(), editPrompt.trim())
      setParadigms((prev) => ({ ...prev, custom: [...prev.custom, created] }))
      onSelect(created.id)
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteParadigm(id)
      setParadigms((prev) => ({ ...prev, custom: prev.custom.filter((p) => p.id !== id) }))
      if (selected === id) onSelect('tech-over-truth')
    } catch {}
  }

  if (loading) return null

  if (editing) {
    return (
      <div className="paradigm-selector">
        <div className="paradigm-label">Judging Paradigm</div>
        <div className="paradigm-editor">
          <div className="paradigm-editor-header">
            <h3>Create Custom Paradigm</h3>
            <button className="paradigm-cancel-btn" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
          </div>
          <label className="paradigm-field">
            Name
            <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={100} placeholder="e.g. My Custom Paradigm" />
          </label>
          <label className="paradigm-field">
            Description
            <input type="text" value={editDesc} onChange={(e) => setEditDesc(e.target.value)} maxLength={200} placeholder="Short description of this judging style" />
          </label>
          <label className="paradigm-field">
            Judging Instructions
            <textarea value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} maxLength={50000} rows={12} placeholder="Instructions for how the AI should judge the round..." />
            <span className="paradigm-char-count">{editPrompt.length.toLocaleString()} / 50,000</span>
          </label>
          {error && <div className="paradigm-error">{error}</div>}
          <button className="paradigm-save-btn" onClick={handleSave} disabled={saving || !editName.trim() || !editPrompt.trim()}>
            {saving ? 'Saving...' : 'Save Paradigm'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="paradigm-selector">
      <div className="paradigm-label">Judging Paradigm</div>
      <div className="paradigm-row">
        <select
          className="paradigm-select"
          value={selected}
          onChange={(e) => {
            if (e.target.value === '__new') {
              startCustom()
            } else {
              onSelect(e.target.value)
            }
          }}
        >
          {allParadigms.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}{p.isBuiltin ? '' : ' (custom)'}
            </option>
          ))}
          <option value="__new">+ Create custom...</option>
        </select>
        {selectedParadigm && !selectedParadigm.isBuiltin && (
          <button
            className="paradigm-delete-btn-inline"
            onClick={() => handleDelete(selected)}
            title="Delete this custom paradigm"
          >
            Delete
          </button>
        )}
      </div>
      {selectedParadigm && (
        <div className="paradigm-desc">{selectedParadigm.description}</div>
      )}
    </div>
  )
}