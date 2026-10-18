import { marked, type Token, type Tokens } from "marked";
import type { SpeechLanguage } from "./NativeSpeech";

const labels = {
  en: { code: "There is a code example in the chat.", table: "There is a table in the chat.", link: "the linked page", longCode: "the code in the chat" },
  es: { code: "Hay un ejemplo de código en el chat.", table: "Hay una tabla en el chat.", link: "la página enlazada", longCode: "el código del chat" },
};

function readable(tokens: readonly Token[] = [], text: typeof labels.en): string {
  return tokens.map((token): string => {
    switch (token.type) {
      case "code": return `\n${text.code}\n`;
      case "table": return `\n${text.table}\n`;
      case "html": case "def": case "hr": case "image": return " ";
      case "br": case "space": return "\n";
      case "list": return token.items.map((item: Tokens.ListItem) => readable(item.tokens, text)).join("\n");
      case "link": return /^(?:https?:\/\/|www\.)/i.test(token.text) ? text.link : readable(token.tokens, text);
      case "paragraph": case "heading": case "blockquote": return `\n${readable(token.tokens, text)}\n`;
      case "strong": case "em": case "del": return readable(token.tokens, text);
      case "text": return token.tokens ? readable(token.tokens, text) : token.text;
      case "codespan": return token.text.length <= 60 ? token.text : text.longCode;
      default: return "";
    }
  }).join("");
}

/** A presentation of the committed message; never a rewrite of the agent's prompt or answer. */
export function speechChunks(markdown: string, language: SpeechLanguage = "en"): string[] {
  const text = readable(marked.lexer(markdown), labels[language]).replace(/https?:\/\/\S+/gi, labels[language].link)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n+/g, "\n").trim();
  if (!text) return [];
  const chunks: string[] = [];
  const segmenter = new Intl.Segmenter(language, { granularity: "sentence" });
  for (const paragraph of text.split("\n")) {
    let prefix = "";
    for (const { segment } of segmenter.segment(paragraph)) {
      let remaining = prefix + segment.trim();
      prefix = "";
      if (/\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Sra|Srta|Jr|St)\.$/i.test(remaining)) { prefix = remaining + " "; continue; }
      while (remaining.length > 600) {
        const space = remaining.lastIndexOf(" ", 600);
        const end = space > 100 ? space : 600;
        chunks.push(remaining.slice(0, end));
        remaining = remaining.slice(end).trim();
      }
      if (remaining) chunks.push(remaining);
    }
    if (prefix.trim()) chunks.push(prefix.trim());
  }
  return chunks;
}
