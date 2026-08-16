import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDirectory } from "@/lib/db";

export function documentDirectory(documentId: string): string {
  return path.join(dataDirectory(), "documents", documentId);
}

export async function writeDocumentArtifact(
  documentId: string,
  filename: string,
  data: Uint8Array | string,
): Promise<string> {
  const directory = documentDirectory(documentId);
  await mkdir(directory, { recursive: true });
  const artifactPath = path.join(directory, filename);
  await writeFile(artifactPath, data);
  return artifactPath;
}

export async function readDocumentArtifact(
  documentId: string,
  filename: string,
): Promise<Buffer> {
  return readFile(path.join(documentDirectory(documentId), filename));
}

export async function ensureExportDirectory(documentId: string): Promise<string> {
  const directory = path.join(documentDirectory(documentId), "exports");
  await mkdir(directory, { recursive: true });
  return directory;
}
