/** Line marks for the messengers a person can pick on their first run, drawn in the instrument's stroke style. */
export function MessengerIcon({ id, size = 22 }: { id: "whatsapp" | "telegram"; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round" as const, "stroke-linejoin": "round" as const, "aria-hidden": "true" as const };
  if (id === "whatsapp") {
    return <svg {...common}>
      <path d="M4.5 19.5l1.1-3.6A8 8 0 1 1 8.4 18.6z" />
      <path d="M9.4 9.2c.2-.6.5-.7.8-.7h.5c.2 0 .4.1.5.4l.6 1.4c.1.2 0 .4-.1.6l-.5.6c.6 1.2 1.6 2.1 2.8 2.7l.6-.6c.2-.2.4-.2.6-.1l1.4.7c.3.1.4.3.4.5v.6c0 .4-.3.8-.8.9-2.9.3-6.9-3.7-6.8-6.6z" />
    </svg>;
  }
  return <svg {...common}>
    <path d="M20.5 4.5l-3 15c-.1.5-.5.7-1 .5l-4.4-3.2-2.1 2c-.2.2-.4.3-.7.3l.3-4.4 8-7.2c.3-.3-.1-.5-.5-.2L7.3 13.5l-4.2-1.3c-.5-.2-.5-.7.1-.9l16.4-6.3c.5-.2.9.1.9.5z" />
  </svg>;
}
