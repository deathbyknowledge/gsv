import { useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { ConfirmModal } from "../../../components/ui/ConfirmModal";
import { ListRow } from "../../../components/ui/ListRow";
import { SectionHeader } from "../../../components/ui/SectionHeader";
import {
  labelForConsoleAccountRelation,
} from "../domain/agentPresentation";
import { compactText, formatAge } from "../domain/consoleFormat";
import type {
  ConsoleAccount,
  ConsoleAdapterAccount,
  ConsoleIdentityLink,
} from "../domain/consoleModels";
import { useRemoveIdentityLink } from "../hooks/useConsoleData";
import {
  adapterName,
  iconForAdapterName,
} from "./messengerPresentation";
import "./MessengerIdentity.css";

function linkKey(link: Pick<ConsoleIdentityLink, "accountId" | "actorId" | "adapter">): string {
  return `${link.adapter}:${link.accountId}:${link.actorId}`;
}

function sameLink(
  left: Pick<ConsoleIdentityLink, "accountId" | "actorId" | "adapter"> | null | undefined,
  right: Pick<ConsoleIdentityLink, "accountId" | "actorId" | "adapter">,
): boolean {
  return Boolean(left)
    && left?.adapter === right.adapter
    && left.accountId === right.accountId
    && left.actorId === right.actorId;
}

function ownerLabel(uid: number, accounts: readonly ConsoleAccount[]): string {
  const account = accounts.find((candidate) => candidate.uid === uid);
  return account
    ? `${account.displayName} / ${labelForConsoleAccountRelation(account.relation)}`
    : `UID ${uid}`;
}

function sortLinks(links: readonly ConsoleIdentityLink[]): ConsoleIdentityLink[] {
  return [...links].sort((left, right) =>
    (right.createdAt ?? 0) - (left.createdAt ?? 0)
    || left.actorId.localeCompare(right.actorId)
  );
}

export function linksForMessengerAccount(
  account: Pick<ConsoleAdapterAccount, "accountId" | "adapter">,
  links: readonly ConsoleIdentityLink[],
): ConsoleIdentityLink[] {
  return sortLinks(links.filter((link) => (
    link.adapter === account.adapter && link.accountId === account.accountId
  )));
}

export function MessengerIdentityLinks({
  accounts,
  errorText,
  links,
  messenger,
  refreshing,
}: {
  accounts: readonly ConsoleAccount[];
  errorText?: string;
  links: readonly ConsoleIdentityLink[];
  messenger: ConsoleAdapterAccount;
  refreshing: boolean;
}) {
  const removeLink = useRemoveIdentityLink();
  const [confirmUnlink, setConfirmUnlink] = useState<ConsoleIdentityLink | null>(null);
  const meta = errorText
    ? "ERROR"
    : refreshing
      ? "SYNCING"
      : `${links.length} ${links.length === 1 ? "LINK" : "LINKS"}`;

  const unlink = async (link: ConsoleIdentityLink) => {
    await removeLink.mutateAsync({
      adapter: link.adapter,
      accountId: link.accountId,
      actorId: link.actorId,
    });
    setConfirmUnlink(null);
  };

  return (
    <>
      <section class="gsv-console-detail-section gsv-messenger-identity-section">
        <SectionHeader title="LINKED IDENTITIES" meta={meta} divider />
        <div class="gsv-messenger-identity-list">
          {errorText ? (
            <div class="gsv-messenger-identity-empty">IDENTITY LINKS UNAVAILABLE / {errorText}</div>
          ) : links.length === 0 ? (
            <div class="gsv-messenger-identity-empty">NO LINKED IDENTITIES</div>
          ) : links.map((link) => {
            const removing = removeLink.isPending && sameLink(removeLink.variables, link);
            return (
              <div class="gsv-messenger-identity-row" key={linkKey(link)}>
                <ListRow
                  icon={iconForAdapterName(link.adapter)}
                  label={link.actorId}
                  status="online"
                  statusDotPlacement="trailing"
                  statusLabel="LINKED"
                  sub={compactText([
                    ownerLabel(link.uid, accounts),
                    link.createdAt === null ? "" : `linked ${formatAge(link.createdAt)}`,
                    link.linkedByUid === null ? "" : `by uid ${link.linkedByUid}`,
                  ], adapterName(link.adapter))}
                  tag={`UID ${link.uid}`}
                  tagTone="info"
                />
                <Button
                  variant="dangerGhost"
                  label={removing ? "REMOVING" : "UNLINK"}
                  disabled={removeLink.isPending}
                  onClick={() => setConfirmUnlink(link)}
                />
              </div>
            );
          })}
        </div>
      </section>
      {removeLink.isError ? (
        <p class="gsv-messenger-identity-error">{removeLink.error.message}</p>
      ) : null}
      {confirmUnlink ? (
        <div class="gsv-console-confirm-layer" onClick={() => setConfirmUnlink(null)}>
          <div class="gsv-console-confirm-wrap" onClick={(event) => event.stopPropagation()}>
            <ConfirmModal
              title="CONFIRM UNLINK"
              message={`Unlink ${confirmUnlink.actorId} from ${messenger.accountId}?`}
              note="Future messages from this external identity will not resolve to the linked GSV account."
              confirmLabel={removeLink.isPending ? "REMOVING" : "UNLINK"}
              onCancel={() => setConfirmUnlink(null)}
              onConfirm={() => void unlink(confirmUnlink)}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
