/** The accent used for the favicon dot; matches `--accent` in gsv-tokens.css. */
export const ATTENTION_ACCENT = "#b3aeff";

/** The parts of the page the tab signal touches, so the policy can run without a browser. */
export type TabAttentionPage = {
  document: Pick<Document, "title" | "visibilityState" | "hasFocus">;
  /** The `link[rel~=icon]` elements; they carry the badge while messages wait and are restored afterwards. */
  icons: readonly Pick<HTMLLinkElement, "href" | "type">[];
  /** Draws the accent dot over the icon at `href` and resolves to a data URL. */
  badge: (href: string) => Promise<string>;
};

export type TabAttention = {
  /** A committed Ship message arrived. It counts once, and only while the tab is out of view. */
  arrived(messageId: string): void;
  /** The tab may be in view again; when it is visible and focused the count, title prefix and badge clear. */
  viewed(): void;
  /** Restores the title and icons regardless of view state. */
  dispose(): void;
  count(): number;
};

export function attentionTitle(base: string, count: number): string {
  return count > 0 ? `(${count}) ${base}` : base;
}

function inView(document: TabAttentionPage["document"]): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/**
 * Counts Ship messages that land while the person is looking elsewhere and
 * shows the count in the tab: "(N) GSV" in the title and a dot on the favicon.
 * Nothing animates; the signal is static until the tab is viewed again.
 */
export function createTabAttention(page: TabAttentionPage): TabAttention {
  const seen = new Set<string>();
  let count = 0;
  let base: string | null = null;
  let original: { href: string; type: string }[] | null = null;
  let badged: string | null = null;
  let drawing = false;

  const showBadge = () => {
    if (badged === null || original !== null) return;
    original = page.icons.map((icon) => ({ href: icon.href, type: icon.type }));
    for (const icon of page.icons) {
      icon.href = badged;
      icon.type = "image/png";
    }
  };

  const clear = () => {
    if (base !== null) {
      page.document.title = base;
      base = null;
    }
    if (original !== null) {
      const restore = original;
      page.icons.forEach((icon, index) => {
        icon.href = restore[index].href;
        icon.type = restore[index].type;
      });
      original = null;
    }
    count = 0;
  };

  return {
    arrived(messageId) {
      if (seen.has(messageId)) return;
      seen.add(messageId);
      if (inView(page.document)) return;
      const title = base ?? page.document.title;
      base = title;
      count += 1;
      page.document.title = attentionTitle(title, count);
      const source = page.icons[0]?.href;
      if (!source) return;
      if (badged !== null) {
        showBadge();
        return;
      }
      if (drawing) return;
      drawing = true;
      page.badge(source).then((href) => {
        badged = href;
        if (count > 0) showBadge();
      }, () => {
        // the icon could not be drawn: the title alone carries the count
      }).finally(() => { drawing = false; });
    },
    viewed() {
      if (inView(page.document)) clear();
    },
    dispose: clear,
    count: () => count,
  };
}

/** Draws the icon at `href` with a filled accent dot in its lower right corner; resolves to a PNG data URL. */
export function badgeIcon(href: string, color = ATTENTION_ACCENT): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const size = 64;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("The favicon canvas has no 2d context."));
        return;
      }
      context.drawImage(image, 0, 0, size, size);
      const radius = size * 0.2;
      context.beginPath();
      context.arc(size - radius, size - radius, radius, 0, Math.PI * 2);
      context.fillStyle = color;
      context.fill();
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = () => reject(new Error(`Could not load the favicon at ${href}.`));
    image.src = href;
  });
}
