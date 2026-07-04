/**
 * SQLite database layer using better-sqlite3.
 *
 * Tables:
 * - feedback: user feedback submissions
 * - raw_transcript_cache: YouTube captions before diarization (enables re-segment without re-fetch)
 * - transcript_cache: diarized transcripts keyed by video_id
 * - flow_cache: generated flow sheets keyed by (video_id, topic)
 * - judge_cache: judging results keyed by (video_id, topic)
 *
 * The raw_transcript_cache is separate from transcript_cache so that
 * re-segmenting (resumeFrom=diarize) can skip the YouTube fetch entirely.
 */

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
      CREATE TABLE IF NOT EXISTS raw_transcript_cache (
        video_id TEXT PRIMARY KEY,
        raw_captions TEXT NOT NULL,
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
        format TEXT NOT NULL DEFAULT 'apda',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS flow_cache (
        video_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        format TEXT NOT NULL DEFAULT 'apda',
        flow TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (video_id, topic, format)
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS judge_cache (
        video_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        paradigm_id TEXT NOT NULL DEFAULT 'tech-over-truth',
        format TEXT NOT NULL DEFAULT 'apda',
        result TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (video_id, topic, paradigm_id, format)
      )
    `)

    // Migration: if judge_cache exists without format column, recreate it
    const judgeCols = db.prepare("PRAGMA table_info(judge_cache)").all() as Array<{ name: string }>
    if (!judgeCols.some((c) => c.name === 'format')) {
      console.log('[db] Migrating judge_cache: adding format column...')
      db.exec(`
        CREATE TABLE IF NOT EXISTS judge_cache_new (
          video_id TEXT NOT NULL,
          topic TEXT NOT NULL,
          paradigm_id TEXT NOT NULL DEFAULT 'tech-over-truth',
          format TEXT NOT NULL DEFAULT 'apda',
          result TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (video_id, topic, paradigm_id, format)
        )
      `)
      db.exec(`INSERT OR IGNORE INTO judge_cache_new (video_id, topic, paradigm_id, format, result, created_at) SELECT video_id, topic, paradigm_id, 'apda', result, created_at FROM judge_cache`)
      db.exec(`DROP TABLE judge_cache`)
      db.exec(`ALTER TABLE judge_cache_new RENAME TO judge_cache`)
      console.log('[db] judge_cache migration complete')
    }

    // Migration: if transcript_cache exists without format column, add it
    const transcriptCols = db.prepare("PRAGMA table_info(transcript_cache)").all() as Array<{ name: string }>
    if (!transcriptCols.some((c) => c.name === 'format')) {
      console.log('[db] Migrating transcript_cache: adding format column...')
      db.exec(`ALTER TABLE transcript_cache ADD COLUMN format TEXT NOT NULL DEFAULT 'apda'`)
      console.log('[db] transcript_cache migration complete')
    }

    // Migration: if flow_cache exists without format column, recreate it
    const flowCols = db.prepare("PRAGMA table_info(flow_cache)").all() as Array<{ name: string }>
    if (!flowCols.some((c) => c.name === 'format')) {
      console.log('[db] Migrating flow_cache: adding format column...')
      db.exec(`
        CREATE TABLE IF NOT EXISTS flow_cache_new (
          video_id TEXT NOT NULL,
          topic TEXT NOT NULL,
          format TEXT NOT NULL DEFAULT 'apda',
          flow TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (video_id, topic, format)
        )
      `)
      db.exec(`INSERT OR IGNORE INTO flow_cache_new (video_id, topic, format, flow, created_at) SELECT video_id, topic, 'apda', flow, created_at FROM flow_cache`)
      db.exec(`DROP TABLE flow_cache`)
      db.exec(`ALTER TABLE flow_cache_new RENAME TO flow_cache`)
      console.log('[db] flow_cache migration complete')
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS custom_paradigms (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL,
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

export interface RawTranscriptCacheRow {
  video_id: string
  raw_captions: string
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
  format: string
  created_at: string
}

export interface FlowCacheRow {
  video_id: string
  topic: string
  format: string
  flow: string
  created_at: string
}

export interface JudgeCacheRow {
  video_id: string
  topic: string
  paradigm_id: string
  format: string
  result: string
  created_at: string
}

export interface CustomParadigmRow {
  id: string
  client_id: string
  name: string
  description: string
  prompt: string
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

// Raw transcript cache (raw captions before diarization)
export function getCachedRawTranscript(videoId: string): RawTranscriptCacheRow | null {
  const db = getDb()
  return db.prepare('SELECT * FROM raw_transcript_cache WHERE video_id = ?').get(videoId) as RawTranscriptCacheRow | null
}

export function saveRawTranscriptCache(videoId: string, rawCaptions: string): void {
  const db = getDb()
  db.prepare(`
    INSERT OR REPLACE INTO raw_transcript_cache (video_id, raw_captions)
    VALUES (?, ?)
  `).run(videoId, rawCaptions)
}

// Transcript cache
export function getCachedTranscript(videoId: string, format: string = 'apda'): TranscriptCacheRow | null {
  const db = getDb()
  return db.prepare('SELECT * FROM transcript_cache WHERE video_id = ? AND format = ?').get(videoId, format) as TranscriptCacheRow | null
}

export function saveTranscriptCache(
  videoId: string,
  rawSegments: string,
  segments: string,
  confidence: string,
  detectedSpeechCount: number,
  topic: string,
  topicInferred: boolean,
  format: string = 'apda',
): void {
  const db = getDb()
  db.prepare(`
    INSERT OR REPLACE INTO transcript_cache (video_id, raw_segments, segments, confidence, detected_speech_count, topic, topic_inferred, format)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(videoId, rawSegments, segments, confidence, detectedSpeechCount, topic, topicInferred ? 1 : 0, format)
}

// Flow cache
export function getCachedFlow(videoId: string, topic: string, format: string = 'apda'): FlowCacheRow | null {
  const db = getDb()
  return db.prepare('SELECT * FROM flow_cache WHERE video_id = ? AND topic = ? AND format = ?').get(videoId, topic, format) as FlowCacheRow | null
}

export function saveFlowCache(videoId: string, topic: string, flow: string, format: string = 'apda'): void {
  const db = getDb()
  db.prepare(`
    INSERT OR REPLACE INTO flow_cache (video_id, topic, format, flow)
    VALUES (?, ?, ?, ?)
  `).run(videoId, topic, format, flow)
}

// Judge cache (keyed by video_id + topic + paradigm_id)
export function getCachedJudge(videoId: string, topic: string, paradigmId: string, format: string = 'apda'): JudgeCacheRow | null {
  const db = getDb()
  return db.prepare('SELECT * FROM judge_cache WHERE video_id = ? AND topic = ? AND paradigm_id = ? AND format = ?').get(videoId, topic, paradigmId, format) as JudgeCacheRow | null
}

export function saveJudgeCache(videoId: string, topic: string, paradigmId: string, result: string, format: string = 'apda'): void {
  const db = getDb()
  db.prepare(`
    INSERT OR REPLACE INTO judge_cache (video_id, topic, paradigm_id, format, result)
    VALUES (?, ?, ?, ?, ?)
  `).run(videoId, topic, paradigmId, format, result)
}

export interface CachedRound {
  videoId: string
  topic: string
  format: string
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
      t.format,
      t.created_at,
      CASE WHEN f.video_id IS NOT NULL THEN 1 ELSE 0 END AS has_flow,
      CASE WHEN j.video_id IS NOT NULL THEN 1 ELSE 0 END AS has_judge
    FROM transcript_cache t
    LEFT JOIN flow_cache f ON t.video_id = f.video_id AND t.topic = f.topic AND t.format = f.format
    LEFT JOIN judge_cache j ON t.video_id = j.video_id AND t.topic = j.topic AND t.format = j.format
    ORDER BY t.created_at DESC
  `).all() as Array<{ video_id: string; topic: string; format: string; created_at: string; has_flow: number; has_judge: number }>

  return rows.map((row) => ({
    videoId: row.video_id,
    topic: row.topic,
    format: row.format || 'apda',
    hasTranscript: true,
    hasFlow: row.has_flow === 1,
    hasJudge: row.has_judge === 1,
    createdAt: row.created_at,
  }))
}

// Custom paradigm CRUD
export function getCustomParadigms(clientId: string): CustomParadigmRow[] {
  const db = getDb()
  return db.prepare('SELECT * FROM custom_paradigms WHERE client_id = ? ORDER BY created_at DESC').all(clientId) as CustomParadigmRow[]
}

export function getCustomParadigm(id: string): CustomParadigmRow | null {
  const db = getDb()
  return db.prepare('SELECT * FROM custom_paradigms WHERE id = ?').get(id) as CustomParadigmRow | null
}

export function saveCustomParadigm(id: string, clientId: string, name: string, description: string, prompt: string): void {
  const db = getDb()
  db.prepare(`
    INSERT OR REPLACE INTO custom_paradigms (id, client_id, name, description, prompt)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, clientId, name, description, prompt)
}

export function deleteCustomParadigm(id: string, clientId: string): boolean {
  const db = getDb()
  const result = db.prepare('DELETE FROM custom_paradigms WHERE id = ? AND client_id = ?').run(id, clientId)
  return result.changes > 0
}