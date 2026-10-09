/**
 * Session database schema (pure, no relative imports).
 *
 * One SQLite file holds the full untruncated transcript text (`chunks`), an
 * FTS5 external-content index, a `sqlite-vec` vector table keyed on the same
 * rowid, and the session graph (`nodes`/`edges`). This module is deliberately
 * dependency-free so Node can execute it via type stripping from the CLI and
 * the app can import it.
 */

export const SESSION_DB_VERSION = 1

export const META_SCHEMA_VERSION = 'schema_version'
export const META_VEC_AVAILABLE = 'vec_available'
export const META_BUILD_EPOCH = 'build_epoch'
export const META_EMBEDDING_MODEL = 'embedding_model'
export const META_VECTOR_DIMS = 'vector_dims'

/** Matryoshka-truncated storage dimension for embeddinggemma-2. */
export const VECTOR_DIMS = 256

export type EmbeddingStatus = 'complete' | 'partial'

export interface ChunkRow {
  id: number
  session_id: string
  parent_id: string | null
  kind: string
  text: string
  text_hash: string
  embedding_status: EmbeddingStatus
  embedding_model: string | null
  dims: number | null
}

export const BASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  git_branch TEXT,
  cwd TEXT,
  started_at TEXT,
  ended_at TEXT,
  build_epoch INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  embedding_status TEXT NOT NULL DEFAULT 'partial',
  embedding_model TEXT,
  dims INTEGER
);
CREATE INDEX IF NOT EXISTS chunks_session ON chunks(session_id);
CREATE INDEX IF NOT EXISTS chunks_hash ON chunks(text_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
  text,
  content='chunks',
  content_rowid='id',
  tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO fts_chunks(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO fts_chunks(fts_chunks, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO fts_chunks(fts_chunks, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO fts_chunks(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  props TEXT
);

CREATE TABLE IF NOT EXISTS edges (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL,
  props TEXT
);
CREATE INDEX IF NOT EXISTS edges_from_type ON edges(from_id, type);
CREATE INDEX IF NOT EXISTS edges_to_type ON edges(to_id, type);
`

export function vecSchemaSql(dims: number = VECTOR_DIMS): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(id INTEGER PRIMARY KEY, embedding float[${dims}] distance_metric=cosine);`
}
