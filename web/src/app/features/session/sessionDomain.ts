export type SetupAccount = {
  username: string;
  password: string;
  passwordConfirm: string;
};

export type SetupAccountErrors = {
  username?: string;
  password?: string;
  passwordConfirm?: string;
};

export const USERNAME_FORMAT_DESCRIPTION = "Use 1-32 characters: lowercase letters, numbers, underscores, or hyphens. Start with a lowercase letter or underscore.";

export function validateSetupAccount(account: SetupAccount): SetupAccountErrors {
  const errors: SetupAccountErrors = {};
  if (!account.username) errors.username = "Username is required.";
  else if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(account.username)) errors.username = USERNAME_FORMAT_DESCRIPTION;
  else if (account.username === INITIAL_AGENT.username) errors.username = "Choose a different username. This name belongs to your Ship.";
  if (account.password.trim().length < 8) errors.password = "Password must be at least 8 characters.";
  if (!account.passwordConfirm) errors.passwordConfirm = "Confirm your password.";
  else if (account.password !== account.passwordConfirm) errors.passwordConfirm = "Passwords do not match.";
  return errors;
}
import { INITIAL_AGENT } from "../../domain/initialAgent";
