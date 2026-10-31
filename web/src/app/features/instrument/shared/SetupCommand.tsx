import { CodeBlock } from "./CodeBlock";

/** A command or code the person copies into a terminal, shown as the chat's code block. */
export function SetupCommand({ text, label, language = "" }: { text: string; label: string; language?: string }) {
  return <CodeBlock text={text} language={language} label={label} line />;
}
