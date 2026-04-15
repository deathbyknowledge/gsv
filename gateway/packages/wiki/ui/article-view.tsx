import { useEffect, useRef } from "preact/hooks";
import type { WikiPreviewRequest } from "./types";
import { renderArticleInto } from "./markdown";

type Props = {
  markdown: string;
  articleTitle: string;
  routeBase: string;
  selectedDb: string;
  selectedPath: string;
  onNavigate(path: string): void;
  onPreviewOpen(anchor: HTMLElement, request: WikiPreviewRequest, pin: boolean): void;
  onPreviewHide(force: boolean): void;
};

export function ArticleView(props: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!bodyRef.current || !props.markdown) {
      return undefined;
    }
    return renderArticleInto(bodyRef.current, props);
  }, [props.markdown, props.articleTitle, props.routeBase, props.selectedDb, props.onNavigate, props.onPreviewOpen, props.onPreviewHide]);

  if (!props.markdown) {
    return <div class="empty-article">Open a page from the left rail, create a new page, or stage source material into an inbox note.</div>;
  }

  return <div class="article-body" ref={bodyRef} />;
}
