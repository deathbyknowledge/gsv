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

If you were given an **invite code** instead, open the operator's signup page
(or **Create a space** in the Desktop app) and enter the code. On the email step,
confirm that you are 18 or older, agree to the Terms of Service, and acknowledge
the Privacy Policy before requesting a verification code. Verify your email with
the six-digit code it sends, then choose the handle your space will live at.
Handles use lowercase letters, numbers and hyphens; uppercase input is converted
automatically. Validation and availability feedback appears beside the field.
The same code resumes the same space if the browser or app is interrupted, and
it works once. The signup page also links to the beta Desktop app for macOS and
Linux; see [Install host apps](/how-to/install-host-apps) for the download and
first-launch steps.

If setup is interrupted or its link expires, opening the unfinished space shows
**Continue setup** instead of the ordinary sign-in form. Sign in with the email
you used to claim the space, then select **Continue** beside its handle. This
renews setup authorization for the same space; you do not need another invite.
For a setup invitation issued directly by an operator, ask the operator to renew it.

If you are already signed in and choose **Use an invite**, confirm the same age,
Terms and Privacy agreement on **Before you begin** before the invite is claimed.
Resuming signup after reopening the browser or app also requires confirmation
before claiming an invite or continuing space creation.

Owner sign-in on **My spaces** lists spaces you own. It is separate from your
account inside each space. Signing in alone does not create a space or grant
operator administration rights. Spaces come from an operator's setup invitation
or an invite code.

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
- **Fleet** lists your places and processes, with files opened from a place.
- **Memory** shows your personal knowledge pages.
- **People** holds conversations, message requests and private contacts across GSV spaces, plus your public profile.
- **Settings** holds preferences (models), standing responsibilities, permissions, instructions, messengers, MCP connections and **Logs** for actions and their outcomes. The **sign-in** section appears only for root, for personal password resets and verified-owner linking.

On phones, tap **menu** in the header to switch views. A dot on the menu button
marks unread People activity. Choosing a view
closes the menu and keeps your drafts. Tap **GSV** to return to Chat.

In Chat, one compact activity line above the prompt combines ongoing plans and
People messages. Tap **N ongoing** (or **plans** when none are active) to open
**ongoing**, **routines** or **history**.
Each responsibility shows a short status and its next check; tap it to read the
full waiting explanation, inspect details or ask Ship about it. Your draft stays
intact while you look. Event-driven policies live in **Settings → standing**.

The **+** menu attaches files, finds people and files, and prepares requests to
create a routine, connect a computer or start a browser. These requests and
**ask Ship** controls add ordinary editable text to your draft. Review or change
it before sending; selecting a request does not send it. **Find a person** accepts
a handle such as `@esteve` or a full address for another GSV. **Reference a file**
adds a file’s target and path as soon as you select its name. Use **../** at the
top of a place’s file list to move toward its filesystem root.

In the browser and when added to your Home Screen, the header and bottom controls
leave room for your phone's notch and home indicator. The star field still fills
the screen, continuing behind the home indicator in the Home Screen app.
Fleet, Memory and Settings scroll to the bottom edge, with extra space after the
last item so it can rest above the home indicator.
Opening the keyboard reduces the content area between the header and composer;
the page itself stays fixed. Lists and message history scroll within that area.
Closing the keyboard restores the conversation's available space. The content
height eases between sizes; reduced motion makes the change immediate. Sign-in and
setup use the same layout.

On phones, **Memory** opens a full-height page browser. Select a page to read it,
then use **← pages** to return. Loading feedback appears in the visible pane.
**new page** and **edit** open the editor; returning to the browser keeps the draft,
with **continue editing →** to resume it. Wider screens show the browser and reader
side by side.

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

On wider screens, open **Help** in the header and choose **Search Chat** to find earlier messages.
Press `Ctrl+K` from any view to open the same search. In Chat, `/` opens search in browse
mode, and `Ctrl/Cmd+F` also works while typing. Open a match to read the
surrounding conversation. Closing search returns to your place and draft.

The composer always shows **Message your ship** when empty. **send** appears beside
the prompt when you have a draft or attachments. The action row below groups **+**
for attachments, the current place, and **record**. The place starts on **your cloud** (`gsv`).
Open its chooser to select another destination for your next message or command;
your draft and selected place stay while you move between views.
While reconnecting, you can keep editing your draft and adding attachments.
Sending becomes available when the connection returns; your draft is not sent automatically.
The header stays above the scrolling content. Tap a message once to select it
and show its timestamp and copy action.
A thin, softly glowing lavender line marks the top of a scrolling pane while
text is cut off there, disappearing in the gaps between lines and rows.

## Next steps

- [Connect devices](/how-to/connect-devices).
- [Bring your own model](/how-to/bring-your-own-model).
- [Connect a messenger](/how-to/messengers).
- [Add integrations](/how-to/integrations).
- [Browse the web](/how-to/browse-web).
- [Personal access](/how-to/invite-people).
- [Examples](/examples/index).
- [FAQ](/get-started/faq).
