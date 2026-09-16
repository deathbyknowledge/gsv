export type SetupAccount = {
  username: string;
  password: string;
};

export const USERNAME_FORMAT_DESCRIPTION = "Use 1-32 characters: lowercase letters, numbers, underscores, or hyphens. Start with a lowercase letter or underscore.";

export function validateSetupAccount(account: SetupAccount): string | null {
  if (!account.username) return "Username is required.";
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(account.username)) return USERNAME_FORMAT_DESCRIPTION;
  if (account.username === INITIAL_AGENT.username) return "Choose a different username. This name belongs to your Ship.";
  if (account.password.trim().length < 8) return "Password must be at least 8 characters.";
  return null;
}
import { INITIAL_AGENT } from "../../domain/initialAgent";
