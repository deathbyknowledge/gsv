# Get Started

A GSV space contains your accounts, conversations, memory and connected machines.
You can use a hosting operator or run the same stack in your own Cloudflare account.

## Get a space

If an operator has created a space for you, open its setup invitation and choose
the username and password you'll use inside that space. Continue to review the
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

- **Zen** is your Ship conversation, and where you inspect what a run did.
- **Fleet** lists your places, processes and responsibilities, and recently touched files.
- **Memory** shows your personal knowledge pages.
- **People** holds conversations, message requests and private contacts across GSV spaces.
- **Settings** holds preferences (models), permissions, instructions, messengers, MCP connections and **Logs** for actions and their outcomes. The **people** and **sign-in** sections appear only for the root account.

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

In Zen, **search** or `Ctrl/Cmd+F` finds earlier messages; `/` opens it in browse
mode. Open a match to read the surrounding conversation. Closing search returns
to your place and draft.

The composer starts on **your cloud** (`gsv`). Choose another place explicitly
when you want a message or command to target it; that choice stays while you
move between views. The header stays above the scrolling content.

## Next steps

- [Connect devices](/how-to/connect-devices).
- [Bring your own model](/how-to/bring-your-own-model).
- [Connect a messenger](/how-to/messengers).
- [Add integrations](/how-to/integrations).
- [Browse the web](/how-to/browse-web).
- [Invite people](/how-to/invite-people).
- [Examples](/examples/index).
- [FAQ](/get-started/faq).
