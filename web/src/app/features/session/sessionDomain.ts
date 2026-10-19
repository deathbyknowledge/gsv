export type SetupAccount = {
  password: string;
  passwordConfirm: string;
};

export type SetupAccountErrors = {
  password?: string;
  passwordConfirm?: string;
};

export function validateSetupAccount(account: SetupAccount): SetupAccountErrors {
  const errors: SetupAccountErrors = {};
  if (account.password.trim().length < 8) errors.password = "Password must be at least 8 characters.";
  if (!account.passwordConfirm) errors.passwordConfirm = "Confirm your password.";
  else if (account.password !== account.passwordConfirm) errors.passwordConfirm = "Passwords do not match.";
  return errors;
}
