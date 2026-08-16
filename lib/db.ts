import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const globalDatabase = globalThis as typeof globalThis & {
  marginDatabase?: DatabaseSync;
};

export function dataDirectory(): string {
  const configured = process.env.DATA_DIR;
  return configured && path.isAbsolute(configured)
    ? configured
    : path.join(process.cwd(), "data");
}

export function getDatabase(): DatabaseSync {
  if (globalDatabase.marginDatabase) return globalDatabase.marginDatabase;
  const directory = dataDirectory();
  mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(path.join(directory, "margin.sqlite"));
  database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  database.exec(SCHEMA);
  globalDatabase.marginDatabase = database;
  return database;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    status TEXT NOT NULL,
    current_version_id TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS document_versions (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    parent_version_id TEXT,
    paper_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
    review_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS edit_proposals (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    base_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    proposal_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );

  CREATE TABLE IF NOT EXISTS api_cache (
    cache_key TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS versions_document_idx
    ON document_versions(document_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS reviews_document_idx
    ON reviews(document_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS proposals_document_idx
    ON edit_proposals(document_id, created_at DESC);
`;
