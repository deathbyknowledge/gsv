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
const USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
// Names the Kernel seeds before the owner's account exists.
const KERNEL_RESERVED_NAMES = new Set(["root", "users", "drivers", "services"]);
const HANDLE_USERNAME_NEXT_STEP = "Change your handle, or choose a different username on the next screen.";

/** Why a valid space handle cannot also serve as the owner's username, or null when it can. */
export function handleUsernameProblem(handle: string): string | null {
  const reason = /^[0-9]/.test(handle) ? "Usernames can't start with a number."
    : handle.length > 32 ? "Usernames can't be longer than 32 characters."
    : handle === INITIAL_AGENT.username ? "This name belongs to your Ship."
    : KERNEL_RESERVED_NAMES.has(handle) ? "This name is reserved inside your space."
    : !USERNAME_PATTERN.test(handle) ? USERNAME_FORMAT_DESCRIPTION : null;
  return reason ? `${reason} ${HANDLE_USERNAME_NEXT_STEP}` : null;
}

export function validateSetupAccount(account: SetupAccount): SetupAccountErrors {
  const errors: SetupAccountErrors = {};
  if (!account.username) errors.username = "Username is required.";
  else if (!USERNAME_PATTERN.test(account.username)) errors.username = USERNAME_FORMAT_DESCRIPTION;
  else if (account.username === INITIAL_AGENT.username) errors.username = "Choose a different username. This name belongs to your Ship.";
  if (account.password.trim().length < 8) errors.password = "Password must be at least 8 characters.";
  if (!account.passwordConfirm) errors.passwordConfirm = "Confirm your password.";
  else if (account.password !== account.passwordConfirm) errors.passwordConfirm = "Passwords do not match.";
  return errors;
}
import { INITIAL_AGENT } from "../../domain/initialAgent";
