import { useState, type ReactNode } from 'react'
import './Collapsible.css'

interface CollapsibleProps {
  title: string
  badge?: string
  defaultOpen?: boolean
  children: ReactNode
}

export function Collapsible({ title, badge, defaultOpen = false, children }: CollapsibleProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className={`collapsible ${open ? 'open' : ''}`}>
      <button className="collapsible-header" onClick={() => setOpen(!open)}>
        <span className="collapsible-arrow">{open ? '\u25BC' : '\u25B6'}</span>
        <span className="collapsible-title">{title}</span>
        {badge && <span className="collapsible-badge">{badge}</span>}
      </button>
      {open && <div className="collapsible-content">{children}</div>}
    </div>
  )
}