import type { FilesContentItem, FilesFilePayload } from "../../../services/files/domain/models";
import { fileName } from "../../../services/files/domain/paths";

export type PreviewBody =
  | { kind: "markdown"; text: string }
  | { kind: "code"; text: string; language: string }
  | { kind: "image"; source: string };

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
// The code-block enhancer marks an empty language as plain text and wraps it.
const PLAIN_TEXT_EXTENSIONS = new Set(["txt", "log"]);

/** The lower-cased extension of the name's last segment; a leading dot (`.bashrc`) is not one. */
function extension(name: string): string {
  const base = fileName(name);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Picks how a read file is shown: Markdown rendered, text as one code block, or an image. Null when there is nothing to show. */
export function previewBody(name: string, payload: FilesFilePayload): PreviewBody | null {
  const { content } = payload;
  if (Array.isArray(content)) {
    const image = content.find((item): item is Extract<FilesContentItem, { type: "image" }> => item.type === "image");
    if (!image?.data || !image.mimeType) return null;
    return { kind: "image", source: `data:${image.mimeType};base64,${image.data}` };
  }

  const ext = extension(name);
  const mediaType = payload.contentType?.split(";")[0].trim().toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(ext) || mediaType === "text/markdown") {
    return { kind: "markdown", text: content };
  }
  return { kind: "code", text: content, language: PLAIN_TEXT_EXTENSIONS.has(ext) ? "" : ext };
}
