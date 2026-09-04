import type { KernelContext } from "./context";
import * as z from "zod/mini";
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
const codexMetadataSchema = z.object({ chatgptAccountId: z.optional(z.string()) });

/** Whether a saved OAuth account can authenticate this provider for one of the accounts, without touching tokens. */
export function hasStoredAiProviderOAuthAccount(
  ctx: KernelContext,
  accountUids: readonly number[],
  provider: string,
): boolean {
  if (provider !== OPENAI_CODEX_PROVIDER) {
    return false;
  }
  return accountUids.some((uid) => ctx.oauth.findAccountByIdentity(
    uid,
    "ai-provider",
    OPENAI_CODEX_PROVIDER,
    OPENAI_CODEX_ACCOUNT_KEY,
  ) !== null);
}

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

function metadataString(
  metadata: Parameters<typeof codexMetadataSchema.safeParse>[0],
  key: string,
): string | null {
  const parsed = codexMetadataSchema.safeParse(metadata);
  if (!parsed.success || key !== "chatgptAccountId") {
    return null;
  }
  const value = parsed.data.chatgptAccountId;
  return value?.trim() || null;
}
