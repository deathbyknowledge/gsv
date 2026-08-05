import type { useAccountHome } from "./useAccountHome";

export type AccountPageActions = ReturnType<typeof useAccountHome> & {
  turnstileToken: string | null;
  turnstileError: boolean;
  setTurnstileToken: (token: string | null) => void;
  setTurnstileError: (value: boolean) => void;
};
