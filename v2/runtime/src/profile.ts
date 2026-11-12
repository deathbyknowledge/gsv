import { z } from "zod";

/**
 * The person profile every person owner gets. M0 carries only its name; agents, conversations,
 * responsibility kinds and content arrive with M5.
 */
export const profileSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
});
export type Profile = z.infer<typeof profileSchema>;

export function profile(input: Profile): Profile {
  return profileSchema.parse(input);
}
