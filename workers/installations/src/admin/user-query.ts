import { z } from "zod";
import { OUTREACH_STATUSES, SEGMENTS } from "./monitoring";

export const USER_SORTS = ["signup", "last_active", "messages", "tasks", "successful_tasks", "last_contacted", "handle", "segment", "outreach", "channel", "country"] as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
const number = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const userQuerySchema = z.object({
  sort: z.enum(USER_SORTS).optional(), direction: z.enum(["asc", "desc"]).optional(),
  segment: z.enum(SEGMENTS).optional(), outreach: z.enum(OUTREACH_STATUSES).optional(),
  channel: z.string().max(100).optional(), country: z.string().regex(/^[A-Z]{2}$/).optional(),
  signupFrom: date.optional(), signupTo: date.optional(), activeFrom: date.optional(), activeTo: date.optional(),
  contactFrom: date.optional(), contactTo: date.optional(),
  minMessages: number.optional(), minTasks: number.optional(), minSuccessfulTasks: number.optional(),
});
export type UserQuery = z.infer<typeof userQuerySchema>;
export const CHANNEL_SQL = `COALESCE(json_extract(i.signup_context_json, '$.acquisition.source'),
  json_extract(i.signup_context_json, '$.acquisition.referral'),
  json_extract(i.signup_context_json, '$.acquisition.referrerHost'), 'unknown')`;
export const MONITORING_JOINS = `LEFT JOIN installation_activity a ON a.installation_id = i.id
  LEFT JOIN installation_outreach outreach ON outreach.installation_id = i.id`;
export const MONITORING_SELECT = `a.captured_at, a.tracked_from, a.first_active_at, a.last_active_at,
  a.messages, a.tasks, a.successful_tasks, a.failed_tasks, a.availability,
  outreach.status AS outreach_status, outreach.notes, outreach.last_contacted_at, outreach.revision AS outreach_revision`;
