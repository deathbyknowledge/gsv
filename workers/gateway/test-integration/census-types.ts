/**
 * Every event type the Kernel registers, and where the census expects its deliveries: to the
 * owner's Ship, to a process, or to no one, on the lane that orders them there.
 * `src/kernel/events/registry.test.ts` keeps these types equal to the registry, so a new type
 * can't skip the census.
 */
export const CENSUS_ROUTES = {
  "message.received": { to: ["ship", "process"], lane: "person" },
  "process.message": { to: ["process"], lane: "background" },
  "work.returned": { to: ["ship"], lane: "person" },
  "ipc.message": { to: ["process"], lane: "background" },
  "ipc.call": { to: ["process"], lane: "background" },
  "ipc.reply": { to: ["process"], lane: "background" },
  "ipc.timeout": { to: ["process"], lane: "background" },
  "ipc.overdue": { to: ["process"], lane: "background" },
  "contact.message": { to: ["ship"], lane: "background" },
  "owner.notified": { to: ["ship"], lane: "background" },
  "responsibility.ready": { to: ["ship"], lane: null },
  "schedule.fired": { to: ["process"], lane: "background" },
  "target.status": { to: ["process"], lane: "background" },
  "delivery.failed": { to: ["process"], lane: "background" },
  "source.event": { to: [], lane: null },
} as const;

export const CENSUS_EVENT_TYPES = Object.keys(CENSUS_ROUTES);
