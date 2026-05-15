import { useMemo } from "preact/hooks";
import type { EstablishContactArgs, SendMessageArgs, SocialBackend, SocialContactSummary } from "./types";
import { AdvancedSection } from "./components/advanced/AdvancedSection";
import { AttentionSection } from "./components/attention/AttentionSection";
import { ChannelsSection } from "./components/channels/ChannelsSection";
import { DirectorySection } from "./components/directory/DirectorySection";
import { AppShell } from "./components/layout/AppShell";
import { ContactsSection } from "./components/contacts/ContactsSection";
import { useSocialData } from "./hooks/useSocialData";
import { useSocialNavigation } from "./hooks/useSocialNavigation";

type AppProps = {
  backend: SocialBackend;
};

export function App({ backend }: AppProps) {
  const navigation = useSocialNavigation();
  const social = useSocialData(backend, navigation.route);
  const shellRoute = social.state?.identity
    ? navigation.route
    : { ...navigation.route, section: "directory" as const, detail: false };
  const selectedContact = useSelectedContact(social.state?.contacts ?? [], navigation.route.contactHandle);
  const selectedDirectory = social.state && selectedContact &&
    social.state.contactDirectory?.contactHandle === selectedContact.handle
    ? social.state.contactDirectory
    : null;

  const sendMessage = async (args: SendMessageArgs): Promise<void> => {
    const nextState = await social.sendMessage(args);
    const channelId = nextState?.selectedChannel?.channel?.channelId;
    if (channelId) {
      navigation.selectChannel(channelId, "channels");
    }
  };

  const establishContact = async (args: EstablishContactArgs): Promise<void> => {
    const nextState = await social.establishContact(args);
    const contact = nextState?.contacts.find((item) => item.handle === args.handle.trim());
    if (contact) {
      navigation.selectContact(contact.handle, "contacts");
    }
  };

  const removeContact = async (handle: string): Promise<void> => {
    await social.removeContact({
      handle,
      channelId: navigation.route.channelId,
    });
    navigation.showList();
  };

  const content = social.state?.identity ? (
    <>
      {navigation.route.section === "inbox" ? (
        <AttentionSection
          state={social.state}
          detail={social.state.selectedChannel}
          selectedWorkflowId={navigation.route.workflowMessageId}
          detailOpen={navigation.route.detail}
          pendingAction={social.pendingAction}
          onSelectWorkflow={navigation.selectWorkflow}
          onSendMessage={sendMessage}
          onUpdateWorkflow={social.updateMessageWorkflow}
        />
      ) : null}
      {navigation.route.section === "channels" ? (
        <ChannelsSection
          state={social.state}
          detail={social.state.selectedChannel}
          selectedChannelId={navigation.route.channelId}
          detailOpen={navigation.route.detail}
          pendingAction={social.pendingAction}
          onSelectChannel={navigation.selectChannel}
          onSendMessage={sendMessage}
          onUpdateWorkflow={social.updateMessageWorkflow}
        />
      ) : null}
      {navigation.route.section === "contacts" ? (
        <ContactsSection
          state={social.state}
          selectedContact={selectedContact}
          contactDirectory={selectedDirectory}
          detailOpen={navigation.route.detail}
          pendingAction={social.pendingAction}
          onSelectContact={(handle) => navigation.selectContact(handle, "contacts")}
          onEstablishContact={establishContact}
          onSaveContactGrants={(args) => social.setContactGrants({
            ...args,
            channelId: navigation.route.channelId,
          })}
          onRemoveContact={removeContact}
          onSendMessage={sendMessage}
        />
      ) : null}
      {navigation.route.section === "directory" ? (
        <DirectorySection
          state={social.state}
          selectedContact={selectedContact}
          contactDirectory={selectedDirectory}
          detailOpen={navigation.route.detail}
          pendingAction={social.pendingAction}
          onSelectContact={(handle) => navigation.selectContact(handle, "directory")}
          onRepublishPublicRecords={social.republishPublicRecords}
        />
      ) : null}
      {navigation.route.section === "advanced" ? (
        <AdvancedSection state={social.state} />
      ) : null}
    </>
  ) : (
    <DirectorySection
      state={social.state}
      selectedContact={null}
      contactDirectory={null}
      detailOpen={navigation.route.detail}
      pendingAction={social.pendingAction}
      onSelectContact={(handle) => navigation.selectContact(handle, "directory")}
      onRepublishPublicRecords={social.republishPublicRecords}
    />
  );

  return (
    <AppShell
      state={social.state}
      route={shellRoute}
      pendingAction={social.pendingAction}
      error={social.error}
      onBack={navigation.showList}
      onClearError={social.clearError}
      onSelectSection={navigation.selectSection}
    >
      {content}
    </AppShell>
  );
}

function useSelectedContact(contacts: SocialContactSummary[], handle: string | null): SocialContactSummary | null {
  return useMemo(() => {
    if (!handle) {
      return null;
    }
    return contacts.find((contact) => contact.handle === handle) ?? null;
  }, [contacts, handle]);
}
