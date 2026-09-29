export function normalizeTimezone(value: string): string {
  const timezone = value.trim();
  if (!timezone) throw new Error("timezone must be a valid IANA timezone");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); }
  catch { throw new Error("timezone must be a valid IANA timezone"); }
  return timezone;
}

/** A human's local time follows their Ship; existing schedules retain their explicit timezone. */
export function ownerTimezone(config: { get(key: string): string | null }, ownerUid: number): string {
  return config.get(`users/${ownerUid}/locale/timezone`) || config.get("config/server/timezone") || "UTC";
}
