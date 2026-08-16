# Real-paper corpus validation

I use this as the anti-overfitting gate for the PDF-to-paper projection. It uploads five unrelated primary-source PDFs through the same production `POST /api/documents` route used by the browser. I do not replay stored TEI fixtures or call the projector directly.

## Corpus

| Paper | Domain / layout stress | Primary PDF | Pages | SHA-256 |
|---|---|---:|---:|---|
| *Attention Is All You Need* | ML; equations, tables, numeric outline | [NeurIPS](https://papers.neurips.cc/paper_files/paper/2017/file/3f5ee243547dee91fbd053c1c4a845aa-Paper.pdf) | 11 | `d87d482d5ae7960e2e43d7dd6d21377e60e73e8fce1bf2a01aff7aca8a08c537` |
| *Deep Residual Learning for Image Recognition* | Vision; dense tables, run-in heads | [CVF](https://openaccess.thecvf.com/content_cvpr_2016/papers/He_Deep_Residual_Learning_CVPR_2016_paper.pdf) | 9 | `51b5de45eb0b558b19c3affe49503cff50cb170a32de602983d6e2ec286942a7` |
| *In Search of an Understandable Consensus Algorithm (Raft)* | Systems; figures, nested sections, split word | [USENIX](https://www.usenix.org/system/files/conference/atc14/atc14-paper-ongaro.pdf) | 16 | `e6345fcba31cbc747ab41755aa62654859c4403dbb687da0021079f78181a7b5` |
| *MapReduce: Simplified Data Processing on Large Clusters* | Systems; multi-column running headers and run-ins | [Google Research](https://static.googleusercontent.com/media/research.google.com/en//archive/mapreduce-osdi04.pdf) | 13 | `ae84cc48ff0005c5a79e095039e54e91dce5c116f65746e1593e819d21830ce9` |
| *Spectre Attacks: Exploiting Speculative Execution* | Security; Roman/lettered outline, URL-only refs, code appendix | [spectreattack.com](https://spectreattack.com/spectre.pdf) | 19 | `4a27dfadc230eb781d0a767c89d3113865b714ee0bb8be82dfb17714fe63fe48` |

I intentionally keep the corpus outside the repository at `/Users/iamjr15/Desktop/answerthis-paper-corpus`, so copyrighted papers are not vendored into the submission.

## Reproduce

Start the production stack, place the five PDFs in one directory, then run:

```bash
docker compose up -d --build
npm run test:corpus -- /Users/iamjr15/Desktop/answerthis-paper-corpus
```

I implemented the runner in [scripts/audit-corpus.mjs](../scripts/audit-corpus.mjs). I upload papers sequentially so the run does not create artificial parser contention.

## Final result — 2026-08-16

| Paper | HTTP / state | Sections | References | Anchors | Unresolved | Warnings |
|---|---|---:|---:|---:|---:|---:|
| Attention | 201 / `READY` | 22 | 32 | 52 | 0 | 0 |
| MapReduce | 201 / `READY` | 41 | 18 | 20 | 0 | 0 |
| Raft | 201 / `READY` | 24 | 35 | 64 | 0 | 0 |
| ResNet | 201 / `READY` | 16 | 49 | 109 | 0 | 0 |
| Spectre | 201 / `READY` | 38 | 78 | 129 | 0 | 0 |
| **Total** | **5/5 passed** | **141** | **212** | **374** | **0** | **0** |

The browser was then used to upload Spectre again from a clean-paper state. It displayed 38 sections and 78 citations, preserved `VIII. CONCLUSIONS`, `IX. ACKNOWLEDGMENTS`, and Appendices A–C, and contained neither `#include` nor `unsigned int array1_size` in the citation pane. See [the browser screenshot](screenshots/09-spectre-corpus-fixed.png).

The same browser document completed a live review with `engine: model`, both Semantic Scholar and OpenAlex at `ok`, 15 provider-backed sources, and two validated findings. The first 35-second model attempt correctly fell back; raising the bounded default to 60 seconds let the structured model path complete while remaining below the route's 180-second limit. Export then produced a CRC-valid seven-file ZIP. Its validation report recorded 129 anchors, 78 references, IEEE style confidence `0.992248`, zero unresolved references, and zero parse warnings.

## Executable audit contract

Every run fails if any paper has:

- a non-201 response, non-`READY` state, missing title/body/reference library, or parse warning;
- duplicate section, paragraph, sentence, reference, or citation-anchor IDs;
- a section pointing to a missing parent, or a non-root section without a parent;
- a citation pointing to a missing reference, a repeated anchor, or a citation inside code;
- return-arrow artifacts, combined appendix headings, lowercase/parenthetical layout fragments, a promoted alphabetic subsection, or a body word absorbed into a Roman heading; or
- preprocessor directives, line-numbered declarations, or C function bodies promoted to bibliography records.

## Root causes found and fixed

1. I was not using GROBID `head@n` and coordinates. I now prefer explicit numbering and use repeated coordinate positions to identify running headers.
2. I initially interpreted IEEE `C.`/`D.` subsection markers as Roman numerals. I now resolve single-letter Roman/alpha ambiguity with practical outline rules while keeping multi-character Roman majors at level one.
3. I found major headings embedded inside paragraph sentences. I added a bounded uppercase-prefix recovery that splits and reparents those sections without consuming the first body word.
4. I found appendices and acknowledgements under unheaded TEI back-matter wrappers. I taught the traversal to understand `annex` and `acknowledgement` containers.
5. GROBID emitted surname particles, dimensions, and punctuation as `bibr` nodes. I now keep only semantically linked or complete citation markers as citation nodes.
6. I found two valid URL-only `Available:` rows with wrapped URLs and a bogus `Available` author. I now convert them into title-less parsed CSL records with repaired URLs.
7. Spectre's bibliography zone extended into a C listing. I now exclude strong preprocessor/declaration/function syntax from references while preserving the same code in the manuscript appendix.

I made every recovery rule structural and syntax-based; none matches a paper title, author, filename, or corpus-specific reference ID.
