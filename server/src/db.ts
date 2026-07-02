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
    db.exec(`
      CREATE TABLE IF NOT EXISTS transcript_cache (
        video_id TEXT PRIMARY KEY,
        raw_segments TEXT NOT NULL,
        segments TEXT NOT NULL,
        confidence TEXT NOT NULL,
        detected_speech_count INTEGER NOT NULL,
        topic TEXT NOT NULL,
        topic_inferred INTEGER NOT NULL DEFAULT 0,
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

export interface TranscriptCacheRow {
  video_id: string
  raw_segments: string
  segments: string
  confidence: string
  detected_speech_count: number
  topic: string
  topic_inferred: number
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

export function getCachedTranscript(videoId: string): TranscriptCacheRow | null {
  const db = getDb()
  return db.prepare('SELECT * FROM transcript_cache WHERE video_id = ?').get(videoId) as TranscriptCacheRow | null
}

export function saveTranscriptCache(
  videoId: string,
  rawSegments: string,
  segments: string,
  confidence: string,
  detectedSpeechCount: number,
  topic: string,
  topicInferred: boolean,
): void {
  const db = getDb()
  db.prepare(`
    INSERT OR REPLACE INTO transcript_cache (video_id, raw_segments, segments, confidence, detected_speech_count, topic, topic_inferred)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(videoId, rawSegments, segments, confidence, detectedSpeechCount, topic, topicInferred ? 1 : 0)
}