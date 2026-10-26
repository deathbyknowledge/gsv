import type { ContactBlockListArgs } from "@humansandmachines/gsv/protocol";
import { useMutation, useQueryClient } from "@tanstack/preact-query";
import { useInfiniteQuery } from "../../../services/navigation/viewQueries";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { ConsoleAccount } from "../../../domain/system/consoleModels";
import { LoadingState } from "../../../components/ui/Spinner";
import { canConfigure } from "../settings/settingsModel";
import { INSTRUMENT_CONTACT_BLOCKS_KEY } from "../wire/queryKeys";
import { useT } from "../../../i18n/locale";

const NO_CURSOR: ContactBlockListArgs["cursor"] = undefined;

export function BlockedPeople({ account }: { account: ConsoleAccount | undefined }) {
  const t = useT();
  const { client, connected } = useGateway();
  const cache = useQueryClient();
  const allowed = (call: string) => connected && !!account && canConfigure(account, call);
  const blocks = useInfiniteQuery({
    queryKey: [...INSTRUMENT_CONTACT_BLOCKS_KEY, "list"], enabled: allowed("contact.block.list"),
    initialPageParam: NO_CURSOR, queryFn: ({ pageParam }) => client.contact.block.list({ cursor: pageParam, limit: 30 }),
    getNextPageParam: (page) => page.nextCursor,
  });
  const unblock = useMutation({
    mutationFn: (did: string) => client.contact.block.set({ did, blocked: false }),
    onSuccess: () => cache.invalidateQueries({ queryKey: INSTRUMENT_CONTACT_BLOCKS_KEY }),
  });
  const entries = blocks.data?.pages.flatMap((page) => page.blocks) ?? [];
  return <section aria-label={t("people.blocked.title")}>
    <p class="people-note">{t("people.blocked.hint")}</p>
    {blocks.isLoading && <LoadingState>{t("common.loading")}</LoadingState>}
    {blocks.data && !entries.length && <p class="people-note">{t("people.blocked.none")}</p>}
    {entries.map((entry) => <div class="people-block-entry" key={entry.did}>
      <div class="people-actions"><span>{entry.displayName ?? t("people.blocked.unknown")}</span><button class="people-action" disabled={!allowed("contact.block.set") || unblock.isPending} onClick={() => unblock.mutate(entry.did)}>{t("people.unblock")}</button></div>
      <details><summary>{t("people.blocked.identity")}</summary><p>{entry.did}</p></details>
    </div>)}
    {blocks.hasNextPage && <button class="people-action" disabled={blocks.isFetchingNextPage} onClick={() => void blocks.fetchNextPage()}>{t("people.more")}</button>}
    {(blocks.error ?? unblock.error) && <p class="people-error" role="alert">{(blocks.error ?? unblock.error)?.message}</p>}
  </section>;
}
