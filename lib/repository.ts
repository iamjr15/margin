import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import {
  type DocumentSnapshot,
  DocumentSnapshotSchema,
  type DocumentStatus,
  type EditProposal,
  EditProposalSchema,
  type Paper,
  PaperSchema,
  type ReviewResult,
  ReviewResultSchema,
} from "@/lib/domain";
import { getDatabase } from "@/lib/db";
import { AppError } from "@/lib/errors";

type Row = Record<string, unknown>;

export function createDocument(filename: string, sourceSha256: string): string {
  const database = getDatabase();
  const id = randomUUID();
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO documents
       (id, filename, source_sha256, status, created_at, updated_at)
       VALUES (?, ?, ?, 'UPLOADED', ?, ?)`,
    )
    .run(id, filename, sourceSha256, now, now);
  return id;
}

export function setDocumentStatus(documentId: string, status: DocumentStatus): void {
  const result = getDatabase()
    .prepare(
      `UPDATE documents
       SET status = ?, error_code = NULL, error_message = NULL, updated_at = ?
       WHERE id = ?`,
    )
    .run(status, new Date().toISOString(), documentId);
  if (result.changes === 0) throw new AppError("document_not_found", "Document not found.", 404);
}

export function setDocumentFailure(
  documentId: string,
  status: Extract<DocumentStatus, "FAILED" | "NEEDS_OCR">,
  code: string,
  message: string,
): void {
  getDatabase()
    .prepare(
      `UPDATE documents
       SET status = ?, error_code = ?, error_message = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(status, code, message, new Date().toISOString(), documentId);
}

export function createPaperVersion(
  documentId: string,
  paper: Paper,
  parentVersionId?: string,
): string {
  const database = getDatabase();
  const versionId = randomUUID();
  const now = new Date().toISOString();
  const validated = PaperSchema.parse(paper);
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `INSERT INTO document_versions
         (id, document_id, parent_version_id, paper_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(versionId, documentId, parentVersionId ?? null, JSON.stringify(validated), now);
    database
      .prepare(
        `UPDATE documents
         SET current_version_id = ?, status = 'READY', updated_at = ?, error_code = NULL,
             error_message = NULL
         WHERE id = ?`,
      )
      .run(versionId, now, documentId);
    database.exec("COMMIT");
    return versionId;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function saveReview(review: ReviewResult): void {
  const parsed = ReviewResultSchema.parse(review);
  getDatabase()
    .prepare(
      `INSERT INTO reviews (id, document_id, version_id, review_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(parsed.id, parsed.documentId, parsed.versionId, JSON.stringify(parsed), parsed.createdAt);
}

export function saveProposal(proposal: EditProposal): void {
  const parsed = EditProposalSchema.parse(proposal);
  getDatabase()
    .prepare(
      `INSERT INTO edit_proposals
       (id, document_id, base_version_id, status, proposal_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      parsed.id,
      parsed.documentId,
      parsed.baseVersionId,
      parsed.status,
      JSON.stringify(parsed),
      parsed.createdAt,
    );
}

export function getProposal(proposalId: string): EditProposal {
  const row = getDatabase()
    .prepare("SELECT proposal_json FROM edit_proposals WHERE id = ?")
    .get(proposalId) as Row | undefined;
  if (!row) throw new AppError("proposal_not_found", "Edit proposal not found.", 404);
  return EditProposalSchema.parse(JSON.parse(String(row.proposal_json)));
}

export function decideProposal(proposal: EditProposal): void {
  const parsed = EditProposalSchema.parse(proposal);
  getDatabase()
    .prepare(
      `UPDATE edit_proposals
       SET status = ?, proposal_json = ?, decided_at = ?
       WHERE id = ?`,
    )
    .run(parsed.status, JSON.stringify(parsed), parsed.decidedAt ?? null, parsed.id);
}

export function approveProposal(proposal: EditProposal, paper: Paper): string {
  const database = getDatabase();
  const versionId = randomUUID();
  const decidedAt = new Date().toISOString();
  const approved = EditProposalSchema.parse({ ...proposal, status: "approved", decidedAt });
  const validatedPaper = PaperSchema.parse(paper);
  database.exec("BEGIN IMMEDIATE");
  try {
    const current = database
      .prepare("SELECT current_version_id FROM documents WHERE id = ?")
      .get(proposal.documentId) as Row | undefined;
    if (!current || current.current_version_id !== proposal.baseVersionId) {
      throw new AppError(
        "stale_proposal",
        "The paper changed after this proposal was created. Generate a new proposal.",
        409,
      );
    }
    database
      .prepare(
        `INSERT INTO document_versions
         (id, document_id, parent_version_id, paper_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        versionId,
        proposal.documentId,
        proposal.baseVersionId,
        JSON.stringify(validatedPaper),
        decidedAt,
      );
    database
      .prepare(
        `UPDATE documents SET current_version_id = ?, status = 'READY', updated_at = ? WHERE id = ?`,
      )
      .run(versionId, decidedAt, proposal.documentId);
    database
      .prepare(
        `UPDATE edit_proposals
         SET status = 'approved', proposal_json = ?, decided_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(JSON.stringify(approved), decidedAt, proposal.id);
    database.exec("COMMIT");
    return versionId;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function getCurrentPaper(documentId: string): { paper: Paper; versionId: string } {
  const row = getDatabase()
    .prepare(
      `SELECT v.id AS version_id, v.paper_json
       FROM documents d
       JOIN document_versions v ON v.id = d.current_version_id
       WHERE d.id = ?`,
    )
    .get(documentId) as Row | undefined;
  if (!row) throw new AppError("paper_not_ready", "This paper is not ready yet.", 409);
  return {
    paper: PaperSchema.parse(JSON.parse(String(row.paper_json))),
    versionId: String(row.version_id),
  };
}

export function getDocumentSnapshot(documentId: string): DocumentSnapshot {
  const database = getDatabase();
  const document = database.prepare("SELECT * FROM documents WHERE id = ?").get(documentId) as
    | Row
    | undefined;
  if (!document) throw new AppError("document_not_found", "Document not found.", 404);

  const currentVersionId = nullableString(document.current_version_id);
  const paperRow = currentVersionId
    ? (database
        .prepare("SELECT paper_json FROM document_versions WHERE id = ?")
        .get(currentVersionId) as Row | undefined)
    : undefined;
  const reviewRow = currentVersionId
    ? (database
        .prepare(
          `SELECT review_json FROM reviews
           WHERE document_id = ? AND version_id = ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(documentId, currentVersionId) as Row | undefined)
    : undefined;
  const proposalRow = database
    .prepare(
      `SELECT proposal_json FROM edit_proposals
       WHERE document_id = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(documentId) as Row | undefined;
  const versionRow = database
    .prepare("SELECT COUNT(*) AS count FROM document_versions WHERE document_id = ?")
    .get(documentId) as Row;

  return DocumentSnapshotSchema.parse({
    id: String(document.id),
    filename: String(document.filename),
    status: String(document.status),
    currentVersionId,
    versionCount: Number(versionRow.count),
    paper: paperRow ? JSON.parse(String(paperRow.paper_json)) : null,
    review: reviewRow ? JSON.parse(String(reviewRow.review_json)) : null,
    proposal: proposalRow ? JSON.parse(String(proposalRow.proposal_json)) : null,
    createdAt: String(document.created_at),
    updatedAt: String(document.updated_at),
    error: document.error_code
      ? { code: String(document.error_code), message: String(document.error_message) }
      : null,
  });
}

export function getCachedJson<T>(key: string): T | null {
  const row = getDatabase()
    .prepare("SELECT payload_json, expires_at FROM api_cache WHERE cache_key = ?")
    .get(key) as Row | undefined;
  if (!row || new Date(String(row.expires_at)).getTime() <= Date.now()) return null;
  return JSON.parse(String(row.payload_json)) as T;
}

export function setCachedJson(key: string, payload: unknown, ttlMs: number): void {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  getDatabase()
    .prepare(
      `INSERT INTO api_cache (cache_key, payload_json, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         payload_json = excluded.payload_json,
         expires_at = excluded.expires_at`,
    )
    .run(key, JSON.stringify(payload), expiresAt);
}

export function sqlValues(values: unknown[]): SQLInputValue[] {
  return values.map((value) => (value === undefined ? null : (value as SQLInputValue)));
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
