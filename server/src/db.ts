import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdirSync, existsSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH ?? join(__dirname, '..', 'data', 'feedback.db')

let db: Database.Database | null = null

function getDb(): Database.Database {
  if (!db) {
    const dbDir = dirname(DB_PATH)
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true })
    }
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
    db.exec(`
      CREATE TABLE IF NOT EXISTS flow_cache (
        video_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        flow TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (video_id, topic)
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS judge_cache (
        video_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (video_id, topic)
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

export interface FlowCacheRow {
  video_id: string
  topic: string
  flow: string
  created_at: string
}

export interface JudgeCacheRow {
  video_id: string
  topic: string
  result: string
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

// Transcript cache
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

// Flow cache
export function getCachedFlow(videoId: string, topic: string): FlowCacheRow | null {
  const db = getDb()
  return db.prepare('SELECT * FROM flow_cache WHERE video_id = ? AND topic = ?').get(videoId, topic) as FlowCacheRow | null
}

export function saveFlowCache(videoId: string, topic: string, flow: string): void {
  const db = getDb()
  db.prepare(`
    INSERT OR REPLACE INTO flow_cache (video_id, topic, flow)
    VALUES (?, ?, ?)
  `).run(videoId, topic, flow)
}

// Judge cache
export function getCachedJudge(videoId: string, topic: string): JudgeCacheRow | null {
  const db = getDb()
  return db.prepare('SELECT * FROM judge_cache WHERE video_id = ? AND topic = ?').get(videoId, topic) as JudgeCacheRow | null
}

export function saveJudgeCache(videoId: string, topic: string, result: string): void {
  const db = getDb()
  db.prepare(`
    INSERT OR REPLACE INTO judge_cache (video_id, topic, result)
    VALUES (?, ?, ?)
  `).run(videoId, topic, result)
}

export interface CachedRound {
  videoId: string
  topic: string
  hasTranscript: boolean
  hasFlow: boolean
  hasJudge: boolean
  createdAt: string
}

export function listCachedRounds(): CachedRound[] {
  const db = getDb()
  const rows = db.prepare(`
    SELECT
      t.video_id,
      t.topic,
      t.created_at,
      CASE WHEN f.video_id IS NOT NULL THEN 1 ELSE 0 END AS has_flow,
      CASE WHEN j.video_id IS NOT NULL THEN 1 ELSE 0 END AS has_judge
    FROM transcript_cache t
    LEFT JOIN flow_cache f ON t.video_id = f.video_id AND t.topic = f.topic
    LEFT JOIN judge_cache j ON t.video_id = j.video_id AND t.topic = j.topic
    ORDER BY t.created_at DESC
  `).all() as Array<{ video_id: string; topic: string; created_at: string; has_flow: number; has_judge: number }>

  return rows.map((row) => ({
    videoId: row.video_id,
    topic: row.topic,
    hasTranscript: true,
    hasFlow: row.has_flow === 1,
    hasJudge: row.has_judge === 1,
    createdAt: row.created_at,
  }))
}