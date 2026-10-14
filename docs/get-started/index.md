# Get Started

A GSV space contains your accounts, conversations, memory and connected machines.
You can use a hosting operator or run the same stack in your own Cloudflare account.

## Get a space

If an operator has created a space for you, open its setup invitation and choose
the password you'll use inside that space. Your space has one personal account;
you do not need to choose another username. Continue to review the
early-access disclosure and confirm the age, Terms of Service and Privacy Policy
agreement before creating your account. This checkbox is required inside the space
as well as on the signup email step. **Back** lets you revise your credentials.
Creating your account signs you in and opens **Ship**, your conversation with your personal agent.
Start with what you want to do. You can connect devices from **Fleet** and
configure models and other connections from **Settings** when you need them.

When your operator enables open registration, use its signup page or **Create
your space** in Desktop. Confirm the age, Terms and Privacy agreement, verify
your email with the six-digit code, then choose a handle. No registration invite
is needed. Handles use lowercase letters, numbers and hyphens; uppercase input
is converted automatically. Validation and availability feedback appears beside
the field. One verified email can create one self-service Space.

A friend's invitation link can take you through the same signup. The invitation
stays with you through setup; accept it in People after choosing who handles
incoming messages. Existing users select their Space instead.

If setup is interrupted or its link expires, opening the unfinished space shows
**Continue setup**. Sign in with the same email and select **Continue** beside its
handle. This resumes the same Space and renews its setup authorization. Previously
created Spaces retain this recovery path after signup codes are retired. For a
setup link issued directly by an operator, ask the operator to renew it.

Owner sign-in on **My spaces** lists the Spaces you own and unfinished setups.
It is separate from your account inside each Space. Signing in alone does not
create a Space or grant operator administration rights. The signup page also
links to the [Desktop app](/how-to/install-host-apps).

## Run your own operator

Use the [Alchemy deployment guide](/how-to/deploy-with-alchemy). You need a
Cloudflare account, a domain in its DNS zones, Node.js and Rust for the build.
The public composition includes CodeMode's Worker Loader, which requires
[Workers Paid](https://developers.cloudflare.com/dynamic-workers/pricing/).
Cloudflare Containers are not required.

Deploy the common stack, issue the one-time operator bootstrap link, then create
your first space. The same deployment can host further isolated spaces. Its
reference inference service uses the operator's Workers AI account; you may add
your own model credentials in a space. Model usage and infrastructure usage are
billed separately. Private H&M services are not required.

Existing standalone deployments should read the
[retirement guide](/how-to/standalone-retirement) before updating.

## Look around

The web console is called **Instrument** and has five views:

- **Chat** is your Ship conversation, and where you inspect what a run did.
- **Fleet** lists your places, processes and responsibilities, and recently touched files.
- **Memory** shows your personal knowledge pages.
- **People** holds conversations, message requests and private contacts across GSV spaces, plus your public profile.
- **Settings** holds preferences (models), permissions, instructions, messengers, MCP connections and **Logs** for actions and their outcomes. The **sign-in** section appears only for root, for personal password resets and verified-owner linking.

The Settings sidebar highlights the section you're viewing.

Open **People** to try making plans or working together with someone on GSV.
**connect** creates a shareable invitation; accepting it opens your conversation.
You can talk directly or choose **ask Ship** to prepare a request in your Ship chat.
A dot beside **people** marks waiting activity, and Zen shows unread conversations
and message requests above the prompt, including after a reload. See
[Contact people](/how-to/contact-people) for the full flow.

If your operator enables cloud browsers, Fleet also offers **start browser**.
You can [sign in and save website logins](/how-to/cloud-browsers) there so Ship
can use those sites while your personal devices are offline.
Ship can use cloud browsers without per-action approval by default. To change
that, select **Cloud browsers** under **Settings → permissions** and choose
**Ask** or **Block**; personal computers and browsers keep their existing rules.

Open **Help** in the header and choose **Search Chat** to find earlier messages.
Press `Ctrl+K` from any view to open the same search. In Chat, `/` opens search in browse
mode, and `Ctrl/Cmd+F` also works while typing. Open a match to read the
surrounding conversation. Closing search returns to your place and draft.

The composer starts on **your cloud** (`gsv`). Choose another place explicitly
when you want a message or command to target it; that choice stays while you
move between views. The header stays above the scrolling content.

## Next steps

- [Connect devices](/how-to/connect-devices).
- [Bring your own model](/how-to/bring-your-own-model).
- [Connect a messenger](/how-to/messengers).
- [Add integrations](/how-to/integrations).
- [Browse the web](/how-to/browse-web).
- [Personal access](/how-to/invite-people).
- [Examples](/examples/index).
- [FAQ](/get-started/faq).
