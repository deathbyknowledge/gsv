import type { DebuggerCommand } from "./backend";
import { abortableDelay, throwIfAborted } from "./abort";
import { createPageSemantics, PageReferenceStore, visibleDialogNodes, type PageElementReference } from "./page-semantics";

export type SemanticLocator = {
  kind: "semantic";
  role?: string;
  name?: string;
  label?: string;
  within?: PageElementReference;
};
type AxNode = {
  nodeId: string;
  parentId?: string;
  ignored?: boolean;
  backendDOMNodeId?: number;
  frameId?: string;
  role?: { value?: string };
  name?: { value?: string };
  properties?: Array<{ name?: string; value?: { value?: unknown } }>;
};
const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch", "slider", "spinbutton", "date", "date-time", "input-time"]);
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const roleName = (role: string) => role.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replaceAll("_", "-").toLowerCase();

/** Resolve accessibility semantics afresh, before input; never retarget a dispatched action. */
export async function findSemanticReference<Target>(
  send: DebuggerCommand<Target>, store: PageReferenceStore, target: Target, tabId: number,
  locator: SemanticLocator, signal?: AbortSignal, timeoutMs = 2000,
): Promise<PageElementReference> {
  const { currentDocumentIdentity } = createPageSemantics(send, store);
  const started = Date.now();
  const initial = await currentDocumentIdentity(target);
  const scope = locator.within;
  if (scope && (scope.tabId !== tabId || scope.documentId !== initial.documentId)) {
    throw new Error("Locator scope belongs to another tab or document. Run page snapshot again.");
  }
  while (true) {
    throwIfAborted(signal);
    const { nodes = [] } = await send<{ nodes?: AxNode[] }>(target, "Accessibility.getFullAXTree");
    const byId = new Map(nodes.map(node => [node.nodeId, node]));
    const scoped = (node: AxNode): boolean => {
      if (!scope) return true;
      let current: AxNode | undefined = node;
      const visited = new Set<string>();
      while (current && !visited.has(current.nodeId)) {
        if (current.backendDOMNodeId === scope.backendNodeId) return true;
        visited.add(current.nodeId);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return false;
    };
    const matches = nodes.filter(node => {
      if (node.ignored || !node.backendDOMNodeId || !scoped(node)) return false;
      const role = roleName(node.role?.value ?? ""), name = normalize(node.name?.value ?? "");
      return (!locator.role || role === roleName(locator.role))
        && (locator.name === undefined || name === normalize(locator.name))
        && (locator.label === undefined || (FIELD_ROLES.has(role) && name === normalize(locator.label)));
    });
    const current = await currentDocumentIdentity(target);
    if (current.documentId !== initial.documentId) throw new Error("The page navigated while resolving the locator. Inspect the new page before continuing.");
    if (matches.length) {
      const snapshotId = store.allocateSnapshotId();
      const refs = matches.map((node, index): PageElementReference => ({
        ref: `@${snapshotId}e${index + 1}`, snapshotId, tabId, documentId: current.documentId,
        frameId: node.frameId ?? current.frameId, backendNodeId: node.backendDOMNodeId!,
        role: roleName(node.role?.value ?? ""), name: normalize(node.name?.value ?? ""),
      }));
      store.save(snapshotId, refs);
      if (refs.length !== 1) {
        throw new Error(`Locator matches ${refs.length} elements. Use --within <@ref> or a specific reference:\n${refs.slice(0, 8).map(ref => `${ref.ref} ${ref.role} ${JSON.stringify(ref.name)}`).join("\n")}`);
      }
      return refs[0]!;
    }
    if (Date.now() - started >= timeoutMs) {
      const dialogs = visibleDialogNodes(nodes);
      const context = dialogs.length ? ` Visible dialog: ${dialogs.map(node => JSON.stringify(normalize(String(node.name?.value ?? "")).slice(0, 240))).join(", ")}. A dialog may hide background content; inspect it before retrying.` : "";
      throw new Error(`No element matches ${describeSemanticLocator(locator)}.${context} Run page snapshot to inspect the current page.`);
    }
    await abortableDelay(Math.min(100, timeoutMs), signal);
  }
}

export function describeSemanticLocator(locator: SemanticLocator): string {
  return [locator.role && `role=${JSON.stringify(locator.role)}`, locator.name !== undefined && `name=${JSON.stringify(locator.name)}`, locator.label !== undefined && `label=${JSON.stringify(locator.label)}`].filter(Boolean).join(" ");
}
