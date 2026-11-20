// Wrangler bundles these as Text modules: Markdown by the Gateway's rule, plain text by default.
declare module "*.md" {
  const content: string;
  export default content;
}

declare module "*.txt" {
  const content: string;
  export default content;
}
