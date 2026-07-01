import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH ?? join(__dirname, '..', 'data', 'feedback.db')

let db: Database.Database | null = null

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH)
    db.exec(`
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT NOT NULL,
        rating INTEGER,
        message TEXT NOT NULL,
        video_url TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
  }
  return db
}

export interface FeedbackRecord {
  id: number
  client_id: string
  rating: number | null
  message: string
  video_url: string | null
  created_at: string
}

export function saveFeedback(clientId: string, message: string, rating?: number, videoUrl?: string): FeedbackRecord {
  const db = getDb()
  const stmt = db.prepare(`
    INSERT INTO feedback (client_id, rating, message, video_url)
    VALUES (?, ?, ?, ?)
  `)
  const info = stmt.run(clientId, rating ?? null, message, videoUrl ?? null)
  const row = db.prepare('SELECT * FROM feedback WHERE id = ?').get(info.lastInsertRowid) as FeedbackRecord
  return row
}

export function getFeedback(limit = 50): FeedbackRecord[] {
  const db = getDb()
  return db.prepare('SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?').all(limit) as FeedbackRecord[]
}

export function getFeedbackCount(): number {
  const db = getDb()
  const row = db.prepare('SELECT COUNT(*) as count FROM feedback').get() as { count: number }
  return row.count
}