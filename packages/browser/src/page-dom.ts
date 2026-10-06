export type InjectedPageResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function snapshotDomPage(selector: unknown): InjectedPageResult<unknown> {
  try {
    const selectorText = typeof selector === "string" && selector.trim() ? selector.trim() : null;
    const root = selectorText ? document.querySelector(selectorText) : document.body ?? document.documentElement;
    if (!root) {
      return { ok: false, error: selectorText ? `No element matches selector: ${selectorText}` : "No document root" };
    }

    const maxDepth = 4;
    const maxChildren = 8;
    const maxTextLength = 180;
    const skippedTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK"]);

    function compactText(element: Element): string | undefined {
      const raw = ((element as HTMLElement).innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      if (!raw) {
        return undefined;
      }
      return raw.length > maxTextLength ? `${raw.slice(0, maxTextLength - 1)}...` : raw;
    }

    function roleFor(element: Element): string | undefined {
      const explicit = element.getAttribute("role");
      if (explicit) {
        return explicit;
      }
      const tag = element.tagName.toLowerCase();
      if (tag === "a" && element.hasAttribute("href")) return "link";
      if (tag === "button") return "button";
      if (tag === "textarea") return "textbox";
      if (tag === "select") return "combobox";
      if (tag === "img") return "img";
      if (tag === "input") {
        const type = (element.getAttribute("type") || "text").toLowerCase();
        if (type === "checkbox" || type === "radio") return type;
        if (type === "button" || type === "submit" || type === "reset") return "button";
        return "textbox";
      }
      return undefined;
    }

    function attrsFor(element: Element): Record<string, string | boolean> | undefined {
      const attrs: Record<string, string | boolean> = {};
      for (const name of [
        "id",
        "aria-label",
        "aria-labelledby",
        "aria-describedby",
        "title",
        "alt",
        "name",
        "type",
        "placeholder",
        "href",
      ]) {
        const value = element.getAttribute(name);
        if (value) {
          attrs[name] = value.length > 160 ? `${value.slice(0, 159)}...` : value;
        }
      }
      if (element instanceof HTMLInputElement && element.checked) {
        attrs.checked = true;
      }
      if (
        (element instanceof HTMLInputElement
          || element instanceof HTMLButtonElement
          || element instanceof HTMLSelectElement
          || element instanceof HTMLTextAreaElement)
        && element.disabled
      ) {
        attrs.disabled = true;
      }
      if (element.hasAttribute("aria-expanded")) {
        attrs["aria-expanded"] = element.getAttribute("aria-expanded") || "";
      }
      return Object.keys(attrs).length > 0 ? attrs : undefined;
    }

    function boundsFor(element: Element): Record<string, number> {
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }

    function isVisible(element: Element): boolean {
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0 || Boolean((element.textContent || "").trim());
    }

    function snapshotElement(element: Element, depth: number): Record<string, unknown> {
      const childElements = Array.from(element.children)
        .filter((child) => !skippedTags.has(child.tagName))
        .filter((child) => depth === 0 || isVisible(child));
      const visibleChildren = childElements.slice(0, maxChildren);
      const node: Record<string, unknown> = { tag: element.tagName.toLowerCase() };
      const text = compactText(element);
      const role = roleFor(element);
      const attrs = attrsFor(element);
      if (text) node.text = text;
      if (role) node.role = role;
      if (attrs) node.attrs = attrs;
      node.bounds = boundsFor(element);
      if (depth < maxDepth && visibleChildren.length > 0) {
        node.children = visibleChildren.map((child) => snapshotElement(child, depth + 1));
      }
      if (childElements.length > maxChildren) {
        node.truncatedChildren = childElements.length - maxChildren;
      }
      return node;
    }

    return {
      ok: true,
      value: {
        url: location.href,
        title: document.title,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: Math.round(window.scrollX),
          scrollY: Math.round(window.scrollY),
        },
        root: snapshotElement(root, 0),
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function readPageText(selector: unknown): InjectedPageResult<{ text: string; count: number }> {
  try {
    const selectorText = typeof selector === "string" && selector.trim() ? selector.trim() : null;
    const elements = selectorText
      ? Array.from(document.querySelectorAll(selectorText))
      : [document.body ?? document.documentElement].filter(Boolean);
    if (elements.length === 0) {
      return { ok: false, error: `No element matches selector: ${selectorText}` };
    }
    const text = elements
      .map((element) => ((element as HTMLElement).innerText || element.textContent || "").trim())
      .filter(Boolean)
      .join("\n\n");
    return { ok: true, value: { text, count: elements.length } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function findPageSelector(selector: unknown): InjectedPageResult<Record<string, unknown> | null> {
  const selectorText = typeof selector === "string" ? selector : "";

  function summarizeElement(element: Element): Record<string, unknown> {
    const rect = element.getBoundingClientRect();
    const attrs: Record<string, string> = {};
    for (const name of ["id", "role", "aria-label", "name", "type", "href", "title"]) {
      const value = element.getAttribute(name);
      if (value) attrs[name] = value;
    }
    return {
      tag: element.tagName.toLowerCase(),
      text: ((element as HTMLElement).innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
      attrs,
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  }

  try {
    const element = document.querySelector(selectorText);
    return { ok: true, value: element ? summarizeElement(element) : null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
