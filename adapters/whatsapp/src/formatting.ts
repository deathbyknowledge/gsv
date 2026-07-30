/** Converts the small Markdown subset produced by GSV into WhatsApp markup. */
export function formatWhatsAppText(input: string): string {
  return input
    .split(/(```[\s\S]*?```|`[^`\n]+`)/g)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      return segment
        .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
        .replace(/\*\*([^*\n]+)\*\*/g, "*$1*");
    })
    .join("");
}
