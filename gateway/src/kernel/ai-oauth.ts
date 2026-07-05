import type { KernelContext } from "./context";
import {
  OPENAI_CODEX_ACCOUNT_KEY,
  OPENAI_CODEX_PROVIDER,
  openAICodexAccountNeedsRefresh,
  refreshOpenAICodexAccount,
} from "./sys/openai-codex-oauth";

export async function resolveAiProviderOAuthApiKey(
  ctx: KernelContext,
  accountUids: number[],
  provider: string,
  configuredApiKey: string,
): Promise<string> {
  if (configuredApiKey.trim() || provider !== OPENAI_CODEX_PROVIDER) {
    return configuredApiKey;
  }

  for (const uid of accountUids) {
    const account = ctx.oauth.findAccountByIdentity(
      uid,
      "ai-provider",
      OPENAI_CODEX_PROVIDER,
      OPENAI_CODEX_ACCOUNT_KEY,
    );
    if (!account) continue;

    const activeAccount = openAICodexAccountNeedsRefresh(account)
      ? await refreshOpenAICodexAccount(ctx.oauth, account)
      : account;
    ctx.oauth.markAccountUsed(activeAccount.accountId, activeAccount.uid);
    return activeAccount.accessToken;
  }

  return configuredApiKey;
}
