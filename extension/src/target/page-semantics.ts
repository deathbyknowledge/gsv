import type { TabSummary } from "../shared/chrome";
import { sendDebuggerCommand } from "../shared/debugger";

const MAX_SNAPSHOTS = 24;
const MAX_SNAPSHOT_NODES = 600;
const MAX_SNAPSHOT_DEPTH = 32;
const MAX_NAME_LENGTH = 500;
const MAX_SYNTHETIC_NAME_LENGTH = 180;
const MAX_DESCRIPTION_LENGTH = 240;

type AxValue = {
  type?: string;
  value?: unknown;
};

type AxProperty = {
  name?: string;
  value?: AxValue;
};

type AxNode = {
  nodeId?: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  description?: AxValue;
  value?: AxValue;
  properties?: AxProperty[];
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
  frameId?: string;
};

type AccessibilityTreeResult = {
  nodes?: AxNode[];
};

type FrameTreeResult = {
  frameTree?: {
    frame?: {
      id?: string;
      loaderId?: string;
      url?: string;
    };
  };
};

type RareBooleanData = {
  index?: number[];
};

type NodeTreeSnapshot = {
  backendNodeId?: number[];
  nodeName?: number[];
  attributes?: number[][];
  isClickable?: RareBooleanData;
};

type LayoutTreeSnapshot = {
  nodeIndex?: number[];
  styles?: number[][];
  bounds?: number[][];
  clientRects?: number[][];
  scrollRects?: number[][];
};

type DocumentSnapshot = {
  nodes?: NodeTreeSnapshot;
  layout?: LayoutTreeSnapshot;
};

type DomSnapshotResult = {
  documents?: DocumentSnapshot[];
  strings?: string[];
};

type DomNodeInfo = {
  tag: string;
  attributes: Record<string, string>;
  clickable: boolean;
  bounds?: Rectangle;
  scroll?: SemanticScroll;
};

type Rectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SemanticScroll = {
  horizontal: boolean;
  vertical: boolean;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
};

export type SemanticNodeState = string | number | boolean;

export type SemanticSnapshotNode = {
  role: string;
  ref?: string;
  name?: string;
  description?: string;
  value?: string | number | boolean;
  valueLength?: number;
  states?: Record<string, SemanticNodeState>;
  scroll?: SemanticScroll;
  bounds?: Rectangle;
  children?: SemanticSnapshotNode[];
};

export type SemanticSnapshot = {
  snapshotId: string;
  tabId: number;
  url: string;
  title: string;
  documentId: string;
  nodes: SemanticSnapshotNode[];
  nodeCount: number;
  referenceCount: number;
  truncated: boolean;
};

export type PageElementReference = {
  ref: string;
  snapshotId: string;
  tabId: number;
  documentId: string;
  frameId: string;
  backendNodeId: number;
  role: string;
  name: string;
};

type StoredSnapshot = {
  id: string;
  references: PageElementReference[];
};

const ACTIONABLE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "gridcell",
  "link",
  "listbox",
  "listitem",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "row",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

const WRAPPER_ROLES = new Set([
  "generic",
  "group",
  "none",
  "paragraph",
  "presentation",
]);

const LEAF_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "gridcell",
  "img",
  "link",
  "listitem",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "row",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

export class PageReferenceStore {
  private readonly snapshots = new Map<string, StoredSnapshot>();
  private readonly references = new Map<string, PageElementReference>();
  private counter = 0;
  private readonly sessionToken = randomToken();

  allocateSnapshotId(): string {
    this.counter += 1;
    return `s${this.sessionToken}${this.counter.toString(36)}`;
  }

  save(snapshotId: string, references: PageElementReference[]): void {
    this.snapshots.set(snapshotId, { id: snapshotId, references });
    for (const reference of references) {
      this.references.set(reference.ref, reference);
    }
    while (this.snapshots.size > MAX_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      const snapshot = this.snapshots.get(oldest);
      this.snapshots.delete(oldest);
      for (const reference of snapshot?.references ?? []) {
        this.references.delete(reference.ref);
      }
    }
  }

  resolve(ref: string): PageElementReference {
    const reference = this.references.get(ref);
    if (!reference) {
      throw new Error(`Unknown or expired page reference: ${ref}. Run page snapshot again.`);
    }
    return reference;
  }

  referenceFor(tabId: number, backendNodeId: number): string | undefined {
    const snapshots = Array.from(this.snapshots.values()).reverse();
    for (const snapshot of snapshots) {
      const reference = snapshot.references.find((candidate) =>
        candidate.tabId === tabId && candidate.backendNodeId === backendNodeId
      );
      if (reference) {
        return reference.ref;
      }
    }
    return undefined;
  }

  clear(): void {
    this.snapshots.clear();
    this.references.clear();
  }
}

export const pageReferences = new PageReferenceStore();

export function isPageReference(value: string): boolean {
  return /^@s[a-z0-9]+e[1-9]\d*$/.test(value);
}

export function normalizePageReference(value: string): string | null {
  if (isPageReference(value)) {
    return value;
  }
  // Generated snapshot ids contain an eight-character session token followed
  // by a snapshot counter. Requiring that minimum keeps ordinary CSS type
  // selectors such as `sectione1` from being mistaken for a bare ref.
  return /^s[a-z0-9]{9,}e[1-9]\d*$/.test(value) ? `@${value}` : null;
}

export async function captureSemanticSnapshot(
  target: chrome.debugger.DebuggerSession,
  tab: TabSummary,
  store: PageReferenceStore = pageReferences,
): Promise<SemanticSnapshot> {
  const [frameTree, accessibility, domSnapshot] = await Promise.all([
    sendDebuggerCommand<FrameTreeResult>(target, "Page.getFrameTree"),
    sendDebuggerCommand<AccessibilityTreeResult>(target, "Accessibility.getFullAXTree"),
    sendDebuggerCommand<DomSnapshotResult>(target, "DOMSnapshot.captureSnapshot", {
      computedStyles: ["overflow-x", "overflow-y"],
      includePaintOrder: false,
      includeDOMRects: true,
    }),
  ]);

  const frame = frameTree.frameTree?.frame;
  const documentId = frame?.loaderId;
  if (!frame?.id || !documentId) {
    throw new Error("Chrome did not return a document identity for the page");
  }
  const rootFrameId = frame.id;

  const snapshotId = store.allocateSnapshotId();
  const domNodes = collectDomNodeInfo(domSnapshot);
  const axNodes = accessibility.nodes ?? [];
  const nodesById = new Map(
    axNodes
      .filter((node): node is AxNode & { nodeId: string } => Boolean(node.nodeId))
      .map((node) => [node.nodeId, node]),
  );
  const rootNodes = axNodes.filter((node) => !node.parentId || !nodesById.has(node.parentId));
  const references: PageElementReference[] = [];
  let nodeCount = 0;
  let truncated = false;

  const render = (node: AxNode, depth: number): SemanticSnapshotNode[] => {
    if (nodeCount >= MAX_SNAPSHOT_NODES || depth > MAX_SNAPSHOT_DEPTH) {
      truncated = true;
      return [];
    }

    const role = normalizeRole(stringValue(node.role));
    if (role === "inline-text-box") {
      return [];
    }
    const states = collectStates(node.properties);
    if (states.hidden === true) {
      return [];
    }
    const backendNodeId = node.backendDOMNodeId;
    const dom = typeof backendNodeId === "number" ? domNodes.get(backendNodeId) : undefined;
    const accessibleName = compact(stringValue(node.name), MAX_NAME_LENGTH);
    const displayedName = accessibleName
      || compact(descendantText(node, nodesById), MAX_SYNTHETIC_NAME_LENGTH);
    const referenceable = typeof backendNodeId === "number" && isReferenceable(role, states, dom);
    const renderedRole = dom?.scroll
      ? "scroll-region"
      : WRAPPER_ROLES.has(role) && referenceable
        ? "element"
        : role;
    const shouldRender = (!node.ignored || referenceable)
      && shouldRenderNode(renderedRole, displayedName, referenceable);
    if (!shouldRender) {
      return (node.childIds ?? []).flatMap((childId) => {
        const child = nodesById.get(childId);
        return child ? render(child, depth) : [];
      });
    }

    nodeCount += 1;
    const output: SemanticSnapshotNode = { role: renderedRole || "element" };
    if (referenceable && typeof backendNodeId === "number") {
      const ref = `@${snapshotId}e${references.length + 1}`;
      output.ref = ref;
      references.push({
        ref,
        snapshotId,
        tabId: tab.id,
        documentId,
        frameId: node.frameId || rootFrameId,
        backendNodeId,
        role,
        name: displayedName,
      });
    }
    if (displayedName) {
      output.name = displayedName;
    }
    const description = compact(stringValue(node.description), MAX_DESCRIPTION_LENGTH);
    if (description && description !== displayedName) {
      output.description = description;
    }
    const value = primitiveValue(node.value);
    const password = dom?.attributes.type?.toLowerCase() === "password";
    const editable = states.editable === true || renderedRole === "textbox" || renderedRole === "searchbox";
    if (value !== undefined && !password && !editable) {
      output.value = typeof value === "string" ? compact(value, MAX_NAME_LENGTH) : value;
    } else if (typeof value === "string" && editable && !password) {
      output.valueLength = value.length;
    }
    if (Object.keys(states).length > 0) {
      output.states = states;
    }
    if (dom?.scroll) {
      output.scroll = dom.scroll;
    }
    if (dom?.bounds) {
      output.bounds = dom.bounds;
    }
    const suppressChildren = Boolean(displayedName) && LEAF_ROLES.has(renderedRole);
    const children = suppressChildren
      ? []
      : (node.childIds ?? []).flatMap((childId) => {
        const child = nodesById.get(childId);
        return child ? render(child, depth + 1) : [];
      });
    if (children.length > 0) {
      output.children = children;
    }
    return [output];
  };

  const nodes = rootNodes.flatMap((root) => render(root, 0));
  store.save(snapshotId, references);
  return {
    snapshotId,
    tabId: tab.id,
    url: frame.url || tab.url || "",
    title: tab.title || "",
    documentId,
    nodes,
    nodeCount,
    referenceCount: references.length,
    truncated,
  };
}

export async function currentDocumentIdentity(
  target: chrome.debugger.DebuggerSession,
): Promise<{ frameId: string; documentId: string; url: string }> {
  const result = await sendDebuggerCommand<FrameTreeResult>(target, "Page.getFrameTree");
  const frame = result.frameTree?.frame;
  if (!frame?.id || !frame.loaderId) {
    throw new Error("Chrome did not return a document identity for the page");
  }
  return {
    frameId: frame.id,
    documentId: frame.loaderId,
    url: frame.url ?? "",
  };
}

export function formatSemanticSnapshot(snapshot: SemanticSnapshot): string {
  const lines = [
    `snapshot ${snapshot.snapshotId} tab=${snapshot.tabId}`,
    `url ${JSON.stringify(snapshot.url)}`,
    `title ${JSON.stringify(snapshot.title)}`,
  ];
  for (const node of snapshot.nodes) {
    formatNode(node, 0, lines);
  }
  if (snapshot.truncated) {
    lines.push(`... truncated after ${snapshot.nodeCount} nodes`);
  }
  lines.push(`refs ${snapshot.referenceCount} (canonical refs include the leading @; bare refs are also accepted)`);
  return `${lines.join("\n")}\n`;
}

function formatNode(node: SemanticSnapshotNode, depth: number, lines: string[]): void {
  const parts = [`${"  ".repeat(depth)}${node.role}`];
  if (node.ref) {
    parts.push(node.ref);
  }
  if (node.name) {
    parts.push(JSON.stringify(node.name));
  }
  if (node.value !== undefined) {
    parts.push(`value=${JSON.stringify(node.value)}`);
  }
  if (node.valueLength !== undefined) {
    parts.push(`value-length=${node.valueLength}`);
  }
  const annotations: string[] = [];
  for (const [name, value] of Object.entries(node.states ?? {})) {
    if (value === true) {
      annotations.push(name);
    } else if (value !== false) {
      annotations.push(`${name}=${String(value)}`);
    }
  }
  if (node.scroll) {
    const axes = [node.scroll.horizontal ? "x" : "", node.scroll.vertical ? "y" : ""].join("");
    annotations.push(`scrollable=${axes}`);
  }
  if (annotations.length > 0) {
    parts.push(`[${annotations.join(" ")}]`);
  }
  lines.push(parts.join(" "));
  for (const child of node.children ?? []) {
    formatNode(child, depth + 1, lines);
  }
}

function collectDomNodeInfo(snapshot: DomSnapshotResult): Map<number, DomNodeInfo> {
  const result = new Map<number, DomNodeInfo>();
  const strings = snapshot.strings ?? [];
  for (const document of snapshot.documents ?? []) {
    const nodes = document.nodes;
    if (!nodes) {
      continue;
    }
    const clickable = new Set(nodes.isClickable?.index ?? []);
    for (let index = 0; index < (nodes.backendNodeId?.length ?? 0); index += 1) {
      const backendNodeId = nodes.backendNodeId?.[index];
      if (typeof backendNodeId !== "number") {
        continue;
      }
      result.set(backendNodeId, {
        tag: stringAt(strings, nodes.nodeName?.[index]).toLowerCase(),
        attributes: attributesAt(strings, nodes.attributes?.[index]),
        clickable: clickable.has(index),
      });
    }

    const layout = document.layout;
    for (let layoutIndex = 0; layoutIndex < (layout?.nodeIndex?.length ?? 0); layoutIndex += 1) {
      const nodeIndex = layout?.nodeIndex?.[layoutIndex];
      const backendNodeId = typeof nodeIndex === "number" ? nodes.backendNodeId?.[nodeIndex] : undefined;
      if (typeof backendNodeId !== "number") {
        continue;
      }
      const info = result.get(backendNodeId);
      if (!info) {
        continue;
      }
      info.bounds = rectangleAt(layout?.bounds?.[layoutIndex]);
      const client = rectangleAt(layout?.clientRects?.[layoutIndex]);
      const scroll = rectangleAt(layout?.scrollRects?.[layoutIndex]);
      if (client && scroll) {
        const styleIndexes = layout?.styles?.[layoutIndex];
        const stylesAvailable = layout?.styles !== undefined;
        const horizontal = scroll.width > client.width + 1
          && (!stylesAvailable || acceptsWheelInput(stringAt(strings, styleIndexes?.[0])));
        const vertical = scroll.height > client.height + 1
          && (!stylesAvailable || acceptsWheelInput(stringAt(strings, styleIndexes?.[1])));
        if (horizontal || vertical) {
          info.scroll = {
            horizontal,
            vertical,
            clientWidth: Math.round(client.width),
            clientHeight: Math.round(client.height),
            scrollWidth: Math.round(scroll.width),
            scrollHeight: Math.round(scroll.height),
          };
        }
      }
    }
  }
  return result;
}

function collectStates(properties: AxProperty[] | undefined): Record<string, SemanticNodeState> {
  const states: Record<string, SemanticNodeState> = {};
  for (const property of properties ?? []) {
    const name = property.name ?? "";
    const value = primitiveValue(property.value);
    if (!name || value === undefined) {
      continue;
    }
    switch (name) {
      case "busy":
      case "checked":
      case "disabled":
      case "editable":
      case "expanded":
      case "focusable":
      case "focused":
      case "hasPopup":
      case "invalid":
      case "multiline":
      case "pressed":
      case "readonly":
      case "required":
      case "selected":
      case "settable":
        states[name] = value;
        break;
    }
  }
  return states;
}

function isReferenceable(
  role: string,
  states: Record<string, SemanticNodeState>,
  dom: DomNodeInfo | undefined,
): boolean {
  return ACTIONABLE_ROLES.has(role)
    || states.focusable === true
    || states.editable === true
    || states.settable === true
    || dom?.clickable === true
    || Boolean(dom?.scroll);
}

function acceptsWheelInput(value: string): boolean {
  const overflow = value.trim().toLowerCase();
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
}

function shouldRenderNode(role: string, name: string, referenceable: boolean): boolean {
  if (!role) {
    return referenceable || Boolean(name);
  }
  if (role === "text") {
    return Boolean(name);
  }
  if (role === "document" || referenceable) {
    return true;
  }
  if (WRAPPER_ROLES.has(role)) {
    return Boolean(name);
  }
  return true;
}

function descendantText(node: AxNode, nodesById: Map<string, AxNode>): string {
  const parts: string[] = [];
  const visit = (current: AxNode, depth: number): void => {
    if (depth > 5 || parts.join(" ").length >= MAX_NAME_LENGTH) {
      return;
    }
    const role = normalizeRole(stringValue(current.role));
    const name = stringValue(current.name).trim();
    if ((role === "text" || role === "img") && name) {
      parts.push(name);
    }
    for (const childId of current.childIds ?? []) {
      const child = nodesById.get(childId);
      if (child) {
        visit(child, depth + 1);
      }
    }
  };
  visit(node, 0);
  return Array.from(new Set(parts)).join(" ");
}

function normalizeRole(value: string): string {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replaceAll("_", "-")
    .toLowerCase();
  switch (normalized) {
    case "root-web-area":
    case "web-area":
      return "document";
    case "static-text":
      return "text";
    case "inline-text-box":
      return "inline-text-box";
    default:
      return normalized;
  }
}

function primitiveValue(value: AxValue | undefined): string | number | boolean | undefined {
  const raw = value?.value;
  return typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean"
    ? raw
    : undefined;
}

function stringValue(value: AxValue | undefined): string {
  const raw = primitiveValue(value);
  return raw === undefined ? "" : String(raw);
}

function attributesAt(strings: string[], indexes: number[] | undefined): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (let index = 0; index < (indexes?.length ?? 0); index += 2) {
    const name = stringAt(strings, indexes?.[index]);
    if (name) {
      attributes[name] = stringAt(strings, indexes?.[index + 1]);
    }
  }
  return attributes;
}

function stringAt(strings: string[], index: number | undefined): string {
  return typeof index === "number" ? strings[index] ?? "" : "";
}

function rectangleAt(value: number[] | undefined): Rectangle | undefined {
  if (!value || value.length < 4 || value.some((part) => !Number.isFinite(part))) {
    return undefined;
  }
  return {
    x: value[0] ?? 0,
    y: value[1] ?? 0,
    width: value[2] ?? 0,
    height: value[3] ?? 0,
  };
}

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function randomToken(): string {
  const bytes = new Uint8Array(4);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (value) => value.toString(36).padStart(2, "0")).join("");
}
