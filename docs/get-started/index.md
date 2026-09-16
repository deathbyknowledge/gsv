# Get Started

A GSV space contains your accounts, conversations, memory and connected machines.
You can use a hosting operator or run the same stack in your own Cloudflare account.

## Get a space

If an operator has created a space for you, open its setup invitation and choose
the username and password you'll use inside that space. Creating your account
signs you in and opens **Ship**, your conversation with your personal agent.
Start with what you want to do. You can connect devices from **Fleet** and
configure models and other connections from **Settings** when you need them.

Owner sign-in on **My spaces** lists spaces you own. It is separate from your
account inside each space. Signing in alone does not create a space or grant
operator administration rights. The operator creates spaces explicitly and
issues their setup invitations.

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

- **Zen** contains your Ship conversation and activity inspection.
- **Fleet** lists machines, processes and contacts.
- **Memory** shows your personal knowledge pages.
- **Ledger** shows actions and their outcomes.
- **Settings** contains models, permissions, messengers and MCP connections.

## Next steps

- [Connect devices](/how-to/connect-devices).
- [Bring your own model](/how-to/bring-your-own-model).
- [Connect a messenger](/how-to/messengers).
- [Add integrations](/how-to/integrations).
- [Web access](/how-to/browse-web).
- [Examples](/examples/index).
- [FAQ](/get-started/faq).
