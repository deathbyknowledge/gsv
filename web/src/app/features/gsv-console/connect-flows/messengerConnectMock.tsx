import { Alert } from "../../../components/ui/Alert";
import { Button } from "../../../components/ui/Button";
import { Link } from "../../../components/ui/Link";
import { ListRow } from "../../../components/ui/ListRow";
import { TextInput } from "../../../components/ui/TextInput";
import type { ConnectFlowDef, ConnectNav } from "./connectFlowTypes";
import { BOTFATHER_URL, MESSENGER_CAPABILITIES, adapterDocUrl } from "../messengers/messengerDocs";

// Telegram-variant static mock of MessengerOnboardingFlow's 4-step wizard.
const TELEGRAM_DOC_URL = adapterDocUrl("telegram");

// Shared footer: BACK + NEXT (labels/handlers overridable per step).
function footer(
  nav: ConnectNav,
  opts: {
    backLabel?: string;
    nextLabel?: string;
    nextVariant?: "primary" | "secondary";
    onBack?: () => void;
    onNext?: () => void;
  } = {},
) {
  const {
    backLabel = "BACK",
    nextLabel = "NEXT",
    nextVariant = "primary",
    onBack = nav.onBack,
    onNext = nav.onNext,
  } = opts;
  return (
    <div class="gsv-cf-footer">
      <Button variant="secondary" label={backLabel} onClick={onBack} />
      <span class="gsv-cf-footer-spacer" />
      <Button variant={nextVariant} label={nextLabel} onClick={onNext} />
    </div>
  );
}

const stepLinksStyle = { display: "flex", flexWrap: "wrap" as const, gap: "16px", alignItems: "center" };
const bodyStyle = { display: "grid", gap: "18px" };

export const messengerConnectFlow: ConnectFlowDef = {
  key: "messengers",
  navLabel: "MESSENGER",
  parentLabel: "MESSENGERS",
  icon: "telegram",
  title: "Connect Telegram bot",
  blurb: "Link a Telegram bot so you can check files and approve tasks from anywhere · Telegram messenger.",
  steps: [
    {
      key: "create",
      label: "CREATE BOT",
      title: "CREATE YOUR GSV BOT",
      meta: "STEP 1 / 4",
      status: "NOT CONNECTED",
      tone: "idle",
      render: (nav) => (
        <div style={bodyStyle}>
          <Alert
            variant="attention"
            text="Do this step in Telegram — finish it there, then come back to GSV."
          />
          <p class="gsv-cf-desc">
            Open BotFather in Telegram and create a new bot to act as your GSV's
            messenger. Send <code>/newbot</code>, pick a name and username, and
            BotFather will set up the account for you.
          </p>
          <div style={stepLinksStyle}>
            <Link href={BOTFATHER_URL}>Open BotFather</Link>
            <Link href={TELEGRAM_DOC_URL} arrow>Documentation</Link>
          </div>
          {footer(nav, { backLabel: "CANCEL" })}
        </div>
      ),
    },
    {
      key: "token",
      label: "GET TOKEN",
      title: "GENERATE AN ACCESS TOKEN",
      meta: "STEP 2 / 4",
      status: "NOT CONNECTED",
      tone: "idle",
      render: (nav) => (
        <div style={bodyStyle}>
          <Alert
            variant="attention"
            text="Do this step in Telegram — finish it there, then come back to GSV."
          />
          <p class="gsv-cf-desc">
            Once the bot is created, BotFather hands you an access token. Copy it —
            you'll paste it into GSV in the next step to connect the bot.
          </p>
          <div style={stepLinksStyle}>
            <Link href={TELEGRAM_DOC_URL} arrow>Documentation</Link>
          </div>
          {footer(nav)}
        </div>
      ),
    },
    {
      key: "connect",
      label: "CONNECT",
      title: "INSERT YOUR ACCESS TOKEN",
      meta: "STEP 3 / 4",
      status: "CONNECTING",
      tone: "warn",
      render: (nav) => (
        <div style={bodyStyle}>
          <p class="gsv-cf-desc">
            Paste the token below to connect your Telegram bot to GSV.
          </p>
          <TextInput
            label="ACCESS TOKEN"
            size="large"
            requirement="required"
            type="password"
            clearable
            value="123456789:AAH-mockTelegramBotTokenValue00mock"
          />
          {footer(nav, { nextLabel: "CONNECT" })}
        </div>
      ),
    },
    {
      key: "link",
      label: "LINK USER",
      title: "LINK YOUR GSV USER",
      meta: "STEP 4 / 4",
      status: "LINKED",
      tone: "online",
      render: (nav) => (
        <div style={bodyStyle}>
          <Alert
            variant="success"
            title="USER LINKED"
            text="@jessica can now authenticate with this GSV."
          />
          <div class="gsv-cf-framed">
            {MESSENGER_CAPABILITIES.map((cap) => (
              <ListRow key={cap.title} label={cap.title} sub={cap.detail} status="none" />
            ))}
          </div>
          <div style={stepLinksStyle}>
            <Link href={TELEGRAM_DOC_URL} arrow>Read the docs</Link>
          </div>
          <div class="gsv-cf-footer">
            <Button variant="secondary" label="VIEW BOT" onClick={nav.onBack} />
            <span class="gsv-cf-footer-spacer" />
            <Button variant="primary" label="DONE" />
          </div>
        </div>
      ),
    },
  ],
};
