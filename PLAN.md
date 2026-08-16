# Implementation plan

This plan turns the 48-hour assessment into one defensible vertical slice. Status reflects the current repository.

## Product goal

Let a researcher upload a real paper, understand the parse, request a source-grounded review, issue a targeted natural-language improvement, approve the exact change, and export a citation-valid revision.

## Non-negotiable acceptance criteria

- [x] Reviewer findings link to real Semantic Scholar/OpenAlex works.
- [x] Provider metadata, not model output, creates every new CSL record.
- [x] Existing citation anchors cannot disappear, duplicate, or move to another sentence.
- [x] Unknown parse results remain visible.
- [x] No edit commits without human approval.
- [x] Export formatting comes from CSL citeproc.

## Delivery sequence

### 1. Establish contracts and persistence — complete

- Define strict schemas for CSL items, text/citation nodes, sections, findings, sources, operations, proposals, and document snapshots.
- Store original artifacts on disk and mutable workflow metadata in SQLite WAL.
- Represent every accepted change as an immutable `document_versions` child.
- Make proposal approval a single `BEGIN IMMEDIATE` transaction with stale-version detection.

Exit check: a document, version, review, and proposal can be recovered without reconstructing state from UI messages.

### 2. Build citation-aware ingestion — complete

- Guard type and size, hash the source, and send the PDF to GROBID.
- Request IDs, sentence segmentation, raw citations, and TEI coordinates.
- Project TEI structure deterministically into the paper IR.
- Convert every bibliography entry to CSL-JSON at ingestion.
- Bind every `ref[type=bibr]` target to stable sentence-local anchors.
- Materialize missing targets and record warnings.
- Detect numeric vs author-date style; expose APA/IEEE override.

Exit check: numeric and author-date fixtures pass; a real nine-page PDF produces sections and eight linked references.

### 3. Add honest scholarly retrieval — complete

- Implement independent Semantic Scholar and OpenAlex adapters.
- Resolve known DOI/provider IDs in batches.
- Use guarded title fallback for unresolved citations.
- Search both providers for missing work and use Semantic Scholar recommendations when seed IDs exist.
- Normalize DOI/title, merge provider provenance, retry 429/5xx, and cache successes.

Exit check: both provider health requests return 200 and normalized results retain provider IDs and CSL.

### 4. Ground the review — complete

- Select a bounded set of cited and uncited claims.
- Supply only resolved abstracts and immutable IDs to the reviewer schema.
- Reject unknown IDs and non-contiguous evidence quotes.
- Distinguish supported, partial, contradicted, and insufficient-abstract outcomes.
- Keep provider status and limitations in the persisted result.

Exit check: every displayed finding resolves to a source link; absent abstracts never become contradiction claims.

### 5. Constrain agentic editing — complete

- Map commands to `SHORTEN_SECTION`, `ADD_CITATIONS`, `ADD_SOURCED_CLAIM`, or `UNSUPPORTED`.
- Execute plans as typed operations, not free-form regenerated documents.
- Require provider-hydrated sources for additions.
- Preserve old anchors in application code.
- Present proposal diff and require approve/reject.
- Run citation invariants before creating a child version.

Exit check: regression tests reject both deletion and cross-sentence movement of an anchor.

### 6. Rebuild and validate export — complete

- Serialize IR to Pandoc Markdown with stable cite keys.
- Render references through official APA/IEEE CSL files.
- Emit TeX and PDF through Pandoc plus Tectonic/`pdflatex`.
- Package PDF, TeX, CSL-JSON, CSL style, and validation report.
- Normalize common Unicode math symbols into portable TeX math.

Exit check: live ZIP has valid CRCs; PDF has nine readable pages; ten references and 26 anchors appear in the report with zero unresolved references.

### 7. Product workflow and evidence — complete

- Make upload the first screen with a focused, composer-like PDF drop target.
- Use a compact workspace rail, durable review thread, persistent command composer, and adjacent manuscript artifact.
- Collapse parse/provider activity into inspectable tool rows and preserve failures, proposals, and decisions in the thread.
- Let the manuscript artifact close for focused thread reading; use explicit Thread/Manuscript tabs on mobile.
- Show citation markers, parse warnings, source provenance, provider health, and approval state.
- Capture parsed, review, proposal, approved, and citation-library screenshots from the real workflow.

Exit check: browser-driven real-paper workflow completes from upload to downloaded ZIP on desktop; both mobile views remain usable without horizontal overflow.

### 8. Submission handoff — complete

- Add interviewer-oriented README.
- Add detailed parsing and agent system design.
- Add AI-tool disclosure, limitations, runbook, screenshots, and third-party notices.
- Run final typecheck, tests, build, Compose validation, and secret scan.

## 48-hour allocation

| Time | Scope | Why |
|---|---|---|
| Hours 0–4 | Contracts, invariants, persistence | Make dangerous states unrepresentable first |
| Hours 4–12 | GROBID + TEI projector + fixtures | Parsing is the foundation and highest design risk |
| Hours 12–20 | Provider adapters + normalization | Establish honest source provenance before prompts |
| Hours 20–28 | Review and edit planner/executor | Keep model work bounded by typed contracts |
| Hours 28–34 | Approval, versions, citeproc export | Close the full vertical slice |
| Hours 34–40 | Workbench UI and responsive states | Make the system inspectable and author-controlled |
| Hours 40–46 | Real-paper QA and failure fixes | Validate against live dependencies and cold starts |
| Hours 46–48 | Design writeup and submission audit | Optimize for the assessment's weighting |

## Risk register

| Risk | Mitigation | Residual limitation |
|---|---|---|
| PDF layout diversity | Use scholarly parser TEI rather than local regex; surface warnings | Figures/equations/layout are not lossless |
| False citation resolution | Prefer DOI/provider IDs; require high title overlap and nearby year | Similar titles can still need author review |
| Hallucinated model source | Model selects supplied IDs only; application hydrates all metadata | Retrieval relevance can be imperfect |
| Citation damage during edits | Sentence-local immutable anchors plus dangling-reference checks | Large document rearrangement is intentionally unsupported |
| Provider throttling | Parallel calls, bounded retry, optional keys, seven-day cache | Anonymous Semantic Scholar is shared quota |
| Long-running parsing/export | Visible busy states, request/process timeouts, health checks | First GROBID/TeX run is slower |
| Stale approval | Proposal stores base version and commits transactionally | No collaborative merge UI |

## Test matrix

| Layer | Test |
|---|---|
| Projection | Numeric fixture, author-date fixture, CSL fields, unknown target warning |
| Retrieval | DOI/title normalization and provider merge provenance |
| Editing | Rewrite preservation, verified addition, deletion rejection, movement rejection |
| Export | Stable cite IDs, unresolved visibility, Unicode math conversion |
| Live | Provider 200s, real GROBID parse, model review, approval, ZIP/PDF validation |
| UI | Desktop and mobile launch; parsed, review, proposal, approved, citations, style-switch, focused-thread, and export states |

## Deliberate scope cuts

- No auth or multi-tenancy: this is a local assessment slice.
- No queue: one manuscript operation at a time is sufficient for the demo.
- No vector database: provider semantic search/recommendations already define the honest retrieval boundary.
- No general autonomous loop: one plan, typed execution, validation, and approval is safer and easier to explain.
- No custom citation formatter: CSL citeproc is the canonical rendering path.
- No OCR or layout-faithful PDF editor: failures are surfaced and documented.
