import { TelegramLinkPage } from "./telegram/TelegramLinkPage";

export function AccountApp({ claimToken }: { claimToken: string | null }) {
  return <TelegramLinkPage claimToken={claimToken} />;
}
