import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { groupInlineNodes, type CslItem, type Paper, type Paragraph, type Sentence } from "@/lib/domain";
import { assertCitationIntegrity } from "@/lib/invariants";
import { ensureExportDirectory } from "@/lib/storage";
import { AppError } from "@/lib/errors";

export interface ExportBundle {
  bytes: Uint8Array;
  filename: string;
}

export async function exportPaper(
  documentId: string,
  versionId: string,
  paper: Paper,
): Promise<ExportBundle> {
  assertCitationIntegrity(paper, paper);
  const exportDirectory = await ensureExportDirectory(documentId);
  const runDirectory = path.join(exportDirectory, versionId);
  const markdownPath = path.join(runDirectory, "paper.md");
  const referencesPath = path.join(runDirectory, "references.json");
  const texPath = path.join(runDirectory, "revised-paper.tex");
  const pdfPath = path.join(runDirectory, "revised-paper.pdf");
  const reportPath = path.join(runDirectory, "validation-report.json");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(runDirectory, { recursive: true });

  const styleName = paper.citationStyle.cslId === "ieee" ? "ieee" : "apa";
  const stylePath = path.join(process.cwd(), "styles", `${styleName}.csl`);
  const markdown = serializePaperToPandoc(paper);
  const references = exportReferences(paper);
  await Promise.all([
    writeFile(markdownPath, markdown),
    writeFile(referencesPath, JSON.stringify(references, null, 2)),
    writeFile(
      reportPath,
      JSON.stringify(
        {
          documentId,
          versionId,
          validatedAt: new Date().toISOString(),
          citationAnchors: countCitations(paper),
          references: paper.references.length,
          unresolvedReferences: paper.references.filter((reference) => reference.status === "unresolved").map((reference) => reference.id),
          parseWarnings: paper.warnings,
          citationStyle: paper.citationStyle,
        },
        null,
        2,
      ),
    ),
  ]);

  const common = [
    markdownPath,
    "--from=markdown+citations",
    "--citeproc",
    `--bibliography=${referencesPath}`,
    `--csl=${stylePath}`,
    "--standalone",
  ];
  await run("pandoc", [...common, "--to=latex", `--output=${texPath}`], runDirectory);
  const pdfEngine = (await commandExists("xelatex"))
    ? "xelatex"
    : (await commandExists("tectonic"))
      ? "tectonic"
      : "pdflatex";
  await run(
    "pandoc",
    [...common, `--pdf-engine=${pdfEngine}`, `--output=${pdfPath}`],
    runDirectory,
    pdfEngine === "tectonic" ? { TECTONIC_UNTRUSTED_MODE: "1" } : undefined,
  );

  const [pdf, tex, sourceMarkdown, referenceJson, report, csl] = await Promise.all([
    readFile(pdfPath),
    readFile(texPath),
    readFile(markdownPath),
    readFile(referencesPath),
    readFile(reportPath),
    readFile(stylePath),
  ]);
  const zip = zipSync(
    {
      "revised-paper.pdf": new Uint8Array(pdf),
      "revised-paper.tex": new Uint8Array(tex),
      "revised-paper.md": new Uint8Array(sourceMarkdown),
      "references.json": new Uint8Array(referenceJson),
      "validation-report.json": new Uint8Array(report),
      [`styles/${styleName}.csl`]: new Uint8Array(csl),
      "README.txt": strToU8(
        "This bundle was rebuilt from a parsed PDF. Review validation-report.json for unresolved references and parsing limitations before submission.\n",
      ),
    },
    { level: 6 },
  );
  return { bytes: zip, filename: `${safeBaseName(paper.title)}-revised.zip` };
}

export function serializePaperToPandoc(paper: Paper): string {
  const authorLines = paper.authors.length
    ? `author:\n${paper.authors.map((author) => `  - ${yamlString(author)}`).join("\n")}\n`
    : "";
  const header = `---\ntitle: ${yamlString(paper.title)}\n${authorLines}nocite: |\n  @*\n---\n`;
  const abstract = paper.abstract.length
    ? `\n## Abstract\n\n${renderParagraphs(paper.abstract)}\n`
    : "";
  const body = paper.sections
    .map((section) => {
      const level = Math.max(2, Math.min(6, section.level + 1));
      return `${"#".repeat(level)} ${escapeMarkdown(section.title)}\n\n${renderParagraphs(section.paragraphs)}`;
    })
    .join("\n\n");
  const unresolved = paper.references.filter((reference) => reference.status === "unresolved");
  const appendix = unresolved.length
    ? `\n\n## Unresolved references\n\n${unresolved
        .map((reference) => `- ${escapeMarkdown(reference.raw || reference.id)}`)
        .join("\n")}\n`
    : "";
  return `${header}${abstract}\n${body}${appendix}`.trimEnd() + "\n";
}

function renderParagraphs(paragraphs: Paragraph[]): string {
  return paragraphs
    .map((paragraph) => {
      if (paragraph.kind === "code") return fencedCode(renderCodeParagraph(paragraph));
      return paragraph.sentences.map(renderSentence).join(" ");
    })
    .join("\n\n");
}

function renderCodeParagraph(paragraph: Paragraph): string {
  return paragraph.sentences
    .map((sentence) =>
      sentence.nodes
        .map((node) => (node.type === "text" ? node.value : node.raw))
        .join(""),
    )
    .join("\n");
}

function renderSentence(sentence: Sentence): string {
  return groupInlineNodes(sentence.nodes)
    .map((group) => {
      if (group.type === "text") return escapeMarkdown(group.value);
      const referenceIds = [...new Set(group.citations.flatMap((citation) => citation.referenceIds))];
      if (!referenceIds.length) {
        return escapeMarkdown(group.citations.map((citation) => citation.raw).join(" "));
      }
      return ` [${referenceIds.map((id) => `@${id}`).join("; ")}]`;
    })
    .join("")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function exportReferences(paper: Paper): CslItem[] {
  return paper.references.map((reference) => ({
    ...reference.csl,
    id: reference.id,
    title: reference.csl.title || reference.raw || `Unresolved reference ${reference.id}`,
  }));
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  extraEnvironment?: Record<string, string>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const processHandle = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnvironment },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timeout = setTimeout(() => processHandle.kill("SIGKILL"), 90_000);
    processHandle.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_000) stderr += chunk.toString();
    });
    processHandle.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    processHandle.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}: ${stderr.slice(0, 1_000)}`));
    });
  }).catch((error) => {
    throw new AppError(
      "export_failed",
      "The revised paper could not be typeset. Check the export dependencies and validation report.",
      500,
      error instanceof Error ? error.message : undefined,
    );
  });
}

async function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function countCitations(paper: Paper): number {
  return [...paper.abstract, ...paper.sections.flatMap((section) => section.paragraphs)]
    .flatMap((paragraph) => paragraph.sentences)
    .flatMap((sentence) => sentence.nodes)
    .filter((node) => node.type === "citation").length;
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/[\u0000-\u001f]/g, " "));
}

function escapeMarkdown(value: string): string {
  const escaped = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/([\\`*_[\]<>@])/g, "\\$1");
  return escaped.replace(/[⋉⊂∂φ∈□⊆∩≥′πψ→∆↔Ξ≤∪]/g, (symbol) =>
    MATH_SYMBOLS[symbol] ?? symbol,
  );
}

function fencedCode(value: string): string {
  const longestFence = Math.max(3, ...[...value.matchAll(/~+/g)].map((match) => match[0].length + 1));
  const fence = "~".repeat(longestFence);
  return `${fence}\n${value.trim()}\n${fence}`;
}

const MATH_SYMBOLS: Record<string, string> = {
  "⋉": "$\\not\\rtimes$", "⊂": "$\\subset$", "∂": "$\\partial$", "φ": "$\\varphi$",
  "∈": "$\\in$", "□": "$\\square$", "⊆": "$\\subseteq$", "∩": "$\\cap$",
  "≥": "$\\geq$", "′": "$^{\\prime}$", "π": "$\\pi$", "ψ": "$\\psi$",
  "→": "$\\to$", "∆": "$\\Delta$", "↔": "$\\leftrightarrow$", "Ξ": "$\\Xi$",
  "≤": "$\\leq$", "∪": "$\\cup$",
};

function safeBaseName(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
    .toLowerCase();
  return normalized || "paper";
}
