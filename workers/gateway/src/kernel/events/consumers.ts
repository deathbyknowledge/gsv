/** The owner's Ship, whichever pid it has when the delivery goes. */
export function shipConsumer(ownerUid: number): string {
  return `personal:${ownerUid}`;
}

/** One process; the delivery is withdrawn once that pid is gone. */
export function processConsumer(pid: string): string {
  return `proc:${pid}`;
}

export type EventConsumer = { kind: "ship"; ownerUid: number } | { kind: "process"; pid: string };

export function parseConsumer(consumer: string): EventConsumer | null {
  const ship = /^personal:(\d+)$/.exec(consumer);
  if (ship) return { kind: "ship", ownerUid: Number(ship[1]) };
  if (consumer.startsWith("proc:") && consumer.length > "proc:".length) return { kind: "process", pid: consumer.slice("proc:".length) };
  return null;
}
