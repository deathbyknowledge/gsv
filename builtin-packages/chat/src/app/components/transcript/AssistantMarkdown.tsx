import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  ASSISTANT_CODE_LINE_HEIGHT,
  ASSISTANT_CODE_PADDING_X,
  ASSISTANT_CODE_PADDING_Y,
  layoutAssistantMarkdown,
  prepareAssistantMarkdown,
  type AssistantMarkdownBlockLayout,
  type AssistantMarkdownFrame,
  type AssistantInlineFragmentLayout,
} from "../../domain/assistant-markdown-frame";

export function AssistantMarkdown({ text }: { text: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [fontsReady, setFontsReady] = useState(() => (
    typeof document === "undefined" || !document.fonts ? true : document.fonts.status === "loaded"
  ));
  const prepared = useMemo(() => prepareAssistantMarkdown(text), [text]);
  const frame = useMemo(() => (
    fontsReady && width > 0 ? layoutAssistantMarkdown(prepared, width) : null
  ), [fontsReady, prepared, width]);

  useEffect(() => {
    if (typeof document === "undefined" || !document.fonts || document.fonts.status === "loaded") {
      setFontsReady(true);
      return undefined;
    }
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) {
        setFontsReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return undefined;
    }
    const update = () => {
      const nextWidth = Math.floor(node.clientWidth);
      setWidth((current) => current === nextWidth ? current : nextWidth);
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div class="assistant-markdown-measure" ref={containerRef}>
      {frame ? <AssistantMarkdownFrameView frame={frame} /> : <pre class="assistant-markdown-plain">{text}</pre>}
    </div>
  );
}

function AssistantMarkdownFrameView({ frame }: { frame: AssistantMarkdownFrame }) {
  return (
    <div
      class="assistant-markdown-frame"
      style={{ height: `${frame.height}px`, width: `${frame.width}px` }}
    >
      {frame.blocks.map((block, index) => <AssistantMarkdownBlock key={index} block={block} />)}
    </div>
  );
}

function AssistantMarkdownBlock({ block }: { block: AssistantMarkdownBlockLayout }) {
  if (block.kind === "inline") {
    return <AssistantInlineBlock block={block} />;
  }
  if (block.kind === "code") {
    return <AssistantCodeBlock block={block} />;
  }
  return <AssistantRuleBlock block={block} />;
}

function AssistantInlineBlock({ block }: { block: Extract<AssistantMarkdownBlockLayout, { kind: "inline" }> }) {
  return (
    <div
      class="assistant-frame-block assistant-frame-inline"
      style={{ height: `${block.height}px`, top: `${block.top}px` }}
    >
      <AssistantBlockChrome block={block} />
      {block.lines.map((line, lineIndex) => (
        <div
          key={lineIndex}
          class="assistant-frame-line"
          style={{
            height: `${block.lineHeight}px`,
            left: `${block.contentLeft}px`,
            top: `${lineIndex * block.lineHeight}px`,
          }}
        >
          {line.fragments.map((fragment, fragmentIndex) => (
            <AssistantInlineFragment key={fragmentIndex} fragment={fragment} />
          ))}
        </div>
      ))}
    </div>
  );
}

function AssistantCodeBlock({ block }: { block: Extract<AssistantMarkdownBlockLayout, { kind: "code" }> }) {
  return (
    <div
      class="assistant-frame-block assistant-frame-code-shell"
      style={{ height: `${block.height}px`, top: `${block.top}px` }}
    >
      <AssistantBlockChrome block={block} />
      <div
        class="assistant-frame-code"
        style={{
          height: `${block.height}px`,
          left: `${block.contentLeft}px`,
          width: `${block.width}px`,
        }}
      >
        {block.lines.map((line, index) => (
          <div
            key={index}
            class="assistant-frame-code-line"
            style={{
              left: `${ASSISTANT_CODE_PADDING_X}px`,
              top: `${ASSISTANT_CODE_PADDING_Y + index * ASSISTANT_CODE_LINE_HEIGHT}px`,
            }}
          >
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function AssistantRuleBlock({ block }: { block: Extract<AssistantMarkdownBlockLayout, { kind: "rule" }> }) {
  return (
    <div
      class="assistant-frame-block assistant-frame-rule-shell"
      style={{ height: `${block.height}px`, top: `${block.top}px` }}
    >
      <AssistantBlockChrome block={block} />
      <div
        class="assistant-frame-rule"
        style={{
          left: `${block.contentLeft}px`,
          top: `${Math.floor(block.height / 2)}px`,
          width: `${block.width}px`,
        }}
      />
    </div>
  );
}

function AssistantBlockChrome({ block }: { block: AssistantMarkdownBlockLayout }) {
  return (
    <>
      {block.quoteRailLefts.map((left, index) => (
        <div key={`rail:${index}`} class="assistant-quote-rail" style={{ left: `${left}px` }} />
      ))}
      {block.markerText && block.markerLeft !== null && block.markerClassName ? (
        <span
          class={block.markerClassName}
          style={{ left: `${block.markerLeft}px`, top: `${markerTop(block)}px` }}
        >
          {block.markerText}
        </span>
      ) : null}
    </>
  );
}

function AssistantInlineFragment({ fragment }: { fragment: AssistantInlineFragmentLayout }) {
  const text = fragment.leadingGap > 0 ? ` ${fragment.text}` : fragment.text;
  if (fragment.href) {
    return (
      <a class={fragment.className} href={fragment.href} target="_blank" rel="noreferrer">
        {text}
      </a>
    );
  }
  return <span class={fragment.className}>{text}</span>;
}

function markerTop(block: AssistantMarkdownBlockLayout): number {
  if (block.kind === "code") {
    return ASSISTANT_CODE_PADDING_Y;
  }
  if (block.kind === "inline") {
    return Math.max(0, Math.round((block.lineHeight - 12) / 2));
  }
  return 0;
}
