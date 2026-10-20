import type { TextKey } from "../../i18n/locale";

export type SetupAccount = {
  password: string;
  passwordConfirm: string;
};

export type SetupAccountErrors = {
  password?: TextKey;
  passwordConfirm?: TextKey;
};

export function validateSetupAccount(account: SetupAccount): SetupAccountErrors {
  const errors: SetupAccountErrors = {};
  if (account.password.trim().length < 8) errors.password = "session.setup.passwordTooShort";
  if (!account.passwordConfirm) errors.passwordConfirm = "session.setup.confirmRequired";
  else if (account.password !== account.passwordConfirm) errors.passwordConfirm = "session.setup.mismatch";
  return errors;
}
