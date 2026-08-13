import { lexer, Parser, type TokensList } from "marked";
import type { MarkdownBlock } from "./markdownProtocol";

export function prepareMarkdownBlocks(source: string): MarkdownBlock[] {
  const tokens = lexer(source, { breaks: true, gfm: true });
  return tokens.flatMap((token, index) => {
    const block = [token] as TokensList;
    block.links = tokens.links;
    const html = Parser.parse(block, { breaks: true, gfm: true });
    return html ? [{ key: `${index}:${token.type}`, html }] : [];
  });
}
