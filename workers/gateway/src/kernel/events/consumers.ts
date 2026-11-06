/** The owner's Ship, whichever pid it has when the delivery goes. */
export function shipConsumer(ownerUid: number): string {
  return `personal:${ownerUid}`;
}

/** One process; the delivery is withdrawn once that pid is gone. */
export function processConsumer(pid: string): string {
  return `proc:${pid}`;
}

/** One messenger chat, by an opaque id: what goes to it goes out in order, whichever process wrote it. */
export function chatConsumer(chatId: string): string {
  return `chat:${chatId}`;
}

export type EventConsumer =
  | { kind: "ship"; ownerUid: number }
  | { kind: "process"; pid: string }
  | { kind: "chat"; chatId: string };

export function parseConsumer(consumer: string): EventConsumer | null {
  const ship = /^personal:(\d+)$/.exec(consumer);
  if (ship) return { kind: "ship", ownerUid: Number(ship[1]) };
  if (consumer.startsWith("proc:") && consumer.length > "proc:".length) return { kind: "process", pid: consumer.slice("proc:".length) };
  if (consumer.startsWith("chat:") && consumer.length > "chat:".length) return { kind: "chat", chatId: consumer.slice("chat:".length) };
  return null;
}

/** One delivery's id, which the Process dedupes by and runs under. */
export function deliveryId(eventId: string, consumer: string): string {
  return `${eventId}:${consumer}`;
}
