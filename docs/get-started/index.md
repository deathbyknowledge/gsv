# Get Started

A GSV space contains your accounts, conversations, memory and connected machines.
You can use a hosting operator or run the same stack in your own Cloudflare account.

## Get a space

If an operator has created a space for you, open its setup invitation and choose
the username and password you'll use inside that space. Continue to review the
early-access disclosure and Privacy Policy notice before creating your account.
Continuing acknowledges the Privacy Policy; there is no additional checkbox inside
the space. **Back** lets you revise your credentials.
Creating your account signs you in and opens **Ship**, your conversation with your personal agent.
Start with what you want to do. You can connect devices from **Fleet** and
configure models and other connections from **Settings** when you need them.

If you were given an **invite code** instead, open the operator's signup page
(or **Create a space** in the Desktop app) and enter the code. On the email step,
confirm that you are 18 or older, agree to the Terms of Service, and acknowledge
the Privacy Policy before requesting a verification code. Verify your email with
the six-digit code it sends, then choose the handle your space will live at.
The same code resumes the same space if the browser or app is interrupted, and
it works once. The signup page also links to the beta Desktop app for macOS and
Linux; see [Install host apps](/how-to/install-host-apps) for the download and
first-launch steps.

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

The web console is called **Instrument** and has four views:

- **Zen** is your Ship conversation, and where you inspect what a run did.
- **Fleet** lists your places, processes, contacts and responsibilities, the ledger of actions and their outcomes, and recently touched files.
- **Memory** shows your personal knowledge pages.
- **Settings** holds preferences (models), permissions, instructions, messengers and MCP connections. The **people** and **sign-in** sections appear only for the root account.

In Zen, **search** or `Ctrl/Cmd+F` finds earlier messages; `/` opens it in browse
mode. Open a match to read the surrounding conversation. Closing search returns
to your place and draft.

## Next steps

- [Connect devices](/how-to/connect-devices).
- [Bring your own model](/how-to/bring-your-own-model).
- [Connect a messenger](/how-to/messengers).
- [Add integrations](/how-to/integrations).
- [Browse the web](/how-to/browse-web).
- [Invite people](/how-to/invite-people).
- [Examples](/examples/index).
- [FAQ](/get-started/faq).
