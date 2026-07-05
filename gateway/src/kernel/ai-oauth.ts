import type { KernelContext } from "./context";
import {
  OPENAI_CODEX_ACCOUNT_KEY,
  OPENAI_CODEX_PROVIDER,
  extractOpenAICodexAccountId,
  openAICodexAccountNeedsRefresh,
  refreshOpenAICodexAccount,
} from "./sys/openai-codex-oauth";

export type ResolvedAiProviderOAuthApiKey = {
  apiKey: string;
  openAiCodexAccountId?: string;
};

export async function resolveAiProviderOAuthApiKey(
  ctx: KernelContext,
  accountUids: number[],
  provider: string,
  configuredApiKey: string,
): Promise<ResolvedAiProviderOAuthApiKey> {
  if (provider !== OPENAI_CODEX_PROVIDER) {
    return { apiKey: configuredApiKey };
  }

  for (const uid of accountUids) {
    const account = ctx.oauth.findAccountByIdentity(
      uid,
      "ai-provider",
      OPENAI_CODEX_PROVIDER,
      OPENAI_CODEX_ACCOUNT_KEY,
    );
    if (!account) continue;

    const needsRefresh = openAICodexAccountNeedsRefresh(account);
    let activeAccount = needsRefresh
      ? await refreshOpenAICodexAccount(ctx.oauth, account)
      : account;
    let openAiCodexAccountId = resolveOpenAiCodexAccountId(activeAccount);
    if (!openAiCodexAccountId && !needsRefresh) {
      activeAccount = await refreshOpenAICodexAccount(ctx.oauth, account);
      openAiCodexAccountId = resolveOpenAiCodexAccountId(activeAccount);
    }
    if (!openAiCodexAccountId) {
      throw new Error("OpenAI Codex OAuth account is missing ChatGPT account id. Reconnect OpenAI Codex to refresh the stored account metadata.");
    }
    ctx.oauth.markAccountUsed(activeAccount.accountId, activeAccount.uid);
    return {
      apiKey: activeAccount.accessToken,
      openAiCodexAccountId,
    };
  }

  return { apiKey: configuredApiKey };
}

function resolveOpenAiCodexAccountId(account: { accessToken: string; metadata?: unknown }): string | null {
  return metadataString(account.metadata, "chatgptAccountId")
    ?? extractOpenAICodexAccountId(account.accessToken);
}

function metadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
