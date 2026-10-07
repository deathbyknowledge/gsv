import { describe, expect, it, vi } from "vitest";
import type { DebuggerCommand } from "@humansandmachines/gsv-browser/backend";
import { findSemanticReference } from "@humansandmachines/gsv-browser/page-locators";
import { PageReferenceStore, type PageElementReference } from "@humansandmachines/gsv-browser/page-semantics";

const field = (id: number, name: string, role = "textbox", parentId = "form") => ({
  nodeId: String(id), backendDOMNodeId: id, parentId, role: { value: role }, name: { value: name },
});
function fixture(nodes: object[], documents = ["document"]) {
  let read = 0;
  const command = vi.fn(async (_target: number, method: string): Promise<unknown> => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame", loaderId: documents[Math.min(read++, documents.length - 1)] } } };
    if (method === "Accessibility.getFullAXTree") return { nodes };
    throw new Error(`Unexpected command: ${method}`);
  });
  // SAFETY: This CDP fixture supplies the response associated with each requested method.
  const send: DebuggerCommand<number> = command as DebuggerCommand<number>;
  const store = new PageReferenceStore();
  return { send, command, store };
}
const scope: PageElementReference = { ref: "@s1e1", snapshotId: "s1", tabId: 7, documentId: "document", frameId: "frame", backendNodeId: 10, role: "form", name: "Journey" };

describe("semantic action locators", () => {
  it("explains visible dialog context when a target is missing, without retrying or matching hidden content", async () => {
    const { send, command, store } = fixture([
      field(1, "Country and language", "dialog"),
      { ...field(2, "Hidden dialog", "dialog"), ignored: true },
      { ...field(3, "Book title", "textbox"), ignored: true },
    ]);
    let message = "";
    try { await findSemanticReference(send, store, 7, 7, { kind: "semantic", label: "Book title" }, undefined, 0); }
    catch (error) { message = String(error); }
    expect(message).toContain('Visible dialog: "Country and language"');
    expect(message).not.toContain("Hidden dialog");
    expect(command.mock.calls.filter(([, method]) => method === "Accessibility.getFullAXTree")).toHaveLength(1);
  });
  it("matches exact field labels and returns a document-bound reference", async () => {
    const { send, store } = fixture([field(1, "From"), field(2, "From station"), field(3, "From", "StaticText")]);
    const ref = await findSemanticReference(send, store, 7, 7, { kind: "semantic", label: "From" });
    expect(ref).toMatchObject({ backendNodeId: 1, tabId: 7, documentId: "document", role: "textbox", name: "From" });
    expect(store.resolve(ref.ref)).toEqual(ref);
  });

  it("rejects ambiguity with usable candidate references instead of choosing the first", async () => {
    const { send, store } = fixture([field(1, "Plan", "button"), field(2, "Plan", "button")]);
    let message = "";
    try { await findSemanticReference(send, store, 7, 7, { kind: "semantic", role: "button", name: "Plan" }); }
    catch (error) { message = String(error); }
    expect(message).toContain("matches 2 elements");
    const refs = message.match(/@s[\da-z]+e\d+/g) ?? [];
    expect(refs).toHaveLength(2);
    expect(refs.map(ref => store.resolve(ref).backendNodeId)).toEqual([1, 2]);
  });

  it("scopes by ancestry, excludes ignored nodes, and resolves beyond the display budget", async () => {
    const { send, store } = fixture([
      ...Array.from({ length: 700 }, (_, i) => field(i + 100, "Plan", "button", "outside")),
      { ...field(10, "Journey", "form"), nodeId: "form", parentId: "root" },
      field(1, "Plan", "button"), { ...field(2, "Plan", "button"), ignored: true },
    ]);
    const ref = await findSemanticReference(send, store, 7, 7, { kind: "semantic", role: "button", name: "Plan", within: scope });
    expect(ref.backendNodeId).toBe(1);
  });

  it("rejects scopes from another tab or document", async () => {
    const { send, store } = fixture([field(1, "From")]);
    for (const within of [{ ...scope, tabId: 8 }, { ...scope, documentId: "old" }]) {
      await expect(findSemanticReference(send, store, 7, 7, { kind: "semantic", label: "From", within })).rejects.toThrow("another tab or document");
    }
  });

  it("does not retarget across a navigation during resolution", async () => {
    const { send, store } = fixture([field(1, "From")], ["document", "new-document"]);
    await expect(findSemanticReference(send, store, 7, 7, { kind: "semantic", label: "From" })).rejects.toThrow("page navigated");
  });

  it("normalizes native control roles and reports a missing match", async () => {
    const { send, store } = fixture([field(1, "Departure time", "InputTime")]);
    expect((await findSemanticReference(send, store, 7, 7, { kind: "semantic", role: "input-time" })).backendNodeId).toBe(1);
    await expect(findSemanticReference(send, store, 7, 7, { kind: "semantic", label: "Arrival time" }, undefined, 0)).rejects.toThrow("No element matches");
  });
});
