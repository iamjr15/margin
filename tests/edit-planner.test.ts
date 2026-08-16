import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/model", () => ({
  getOpenAI: () => ({ responses: { parse: async () => { throw new Error("model unavailable"); } } }),
  hasModelAccess: () => true,
  modelName: () => "test-model",
}));

import { proposeEdit } from "@/lib/edit";
import { projectTeiToPaper } from "@/lib/tei-projector";

describe("edit planner provenance", () => {
  it("labels a configured but failed model call as deterministic fallback", async () => {
    const paper = projectTeiToPaper(
      readFileSync(new URL("./fixtures/numeric-paper.tei.xml", import.meta.url), "utf8"),
      "planner-fallback",
    );
    const text = paper.sections[0]?.paragraphs[0]?.sentences[0]?.nodes[0];
    if (text?.type === "text") {
      text.value = "It is important to note that our representation is very carefully designed in order to keep every existing citation anchor explicitly attached to its original sentence and context ";
    }

    const proposal = await proposeEdit("document-1", "version-1", paper, "Make the introduction shorter");

    expect(proposal.engine).toBe("deterministic-fallback");
    expect(proposal.operations.some((operation) => operation.type === "replace-sentence")).toBe(true);
  });
});
