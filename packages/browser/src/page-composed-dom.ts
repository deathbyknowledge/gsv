// These functions are serialized into the page's execution context. Keep their
// implementations self-contained, without references to module-level values.
export function pageInputTargetsRelated(this: Node, other: Node | { element: Element }): boolean {
  // CDP can hit a CSSPseudoElement. Its originating element receives the input.
  if (!(other instanceof Node)) other = other.element;
  const contains = (ancestor: Node, node: Node): boolean => {
    for (let current: Node | null = node; current;) {
      if (current === ancestor) return true;
      current = current instanceof Element && current.assignedSlot
        ? current.assignedSlot
        : current instanceof ShadowRoot ? current.host : current.parentNode;
    }
    return false;
  };
  return this.contains(other) || other.contains(this)
    || contains(this, other) || contains(other, this);
}

export function pageActiveElement(): Element | null {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) {
    element = element.shadowRoot.activeElement;
  }
  return element;
}

export function observePageMutations(changed: (count: number) => void): MutationObserver {
  const roots = new WeakSet<Node>();
  const observer = new MutationObserver((entries) => {
    changed(entries.length);
    for (const entry of entries) {
      entry.addedNodes.forEach((node) => {
        if (node instanceof Element) visit(node);
      });
    }
  });
  const observe = (root: Document | ShadowRoot): void => {
    if (roots.has(root)) return;
    roots.add(root);
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    root.querySelectorAll("*").forEach((element) => {
      if (element.shadowRoot) observe(element.shadowRoot);
    });
  };
  const visit = (element: Element): void => {
    if (element.shadowRoot) observe(element.shadowRoot);
    element.querySelectorAll("*").forEach((child) => {
      if (child.shadowRoot) observe(child.shadowRoot);
    });
  };
  observe(document);
  return observer;
}
