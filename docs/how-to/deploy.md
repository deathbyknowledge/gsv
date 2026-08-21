# Deploy, Update, and Remove

## Deploy

Go to [deploy.gsv.space](https://deploy.gsv.space) and follow the steps. It connects your Cloudflare account, provisions the required Workers and Durable Objects, and leaves you with a running GSV instance.

You will need:

- A Cloudflare account
- Your Cloudflare API token (the deploy tool will walk you through creating one with the right permissions)

Once complete, your GSV instance is live and reachable via the CLI or any adapter you connect.

The supported baseline uses Workers, R2, and SQLite-backed Durable Objects. It
does not use Cloudflare Containers and can run on Workers Free. CodeMode's
Worker Loader binding is paid-only; automatic deployment omits it on Free
accounts while leaving the rest of GSV available.

For WhatsApp, budget the Free plan for one continuously connected account. Its
[outbound WebSocket prevents account Durable Object eviction for at most 15
minutes per connection](https://developers.cloudflare.com/changelog/post/2026-06-19-outbound-connections-keep-dos-alive/).
The connection itself can continue after that cap, but it stops preventing
eviction. While the transport is healthy, the account schedules an alarm every
30 seconds so an incoming event reaches the Durable Object before Cloudflare's
minimum idle eviction window. Routine residency maintenance therefore keeps the
same provider session; only an unhealthy transport reconnects with the saved
credentials.
That is roughly 2,880 alarm requests and writes per day, but resident duration
is the tighter limit: one continuously resident 128 MB object is about 11,060
GB-s against Cloudflare's current 13,000 GB-s daily Free allowance. This is an
operating estimate, not a hard account-capacity guarantee, because other active
Durable Objects use the same allowance. Review the current
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
before operating several always-connected accounts.

The equivalent CLI deployment is:

```bash
gsv infra deploy --all
```

To add or update only WhatsApp later, run:

```bash
gsv infra deploy -c channel-whatsapp
```

The deployer also refreshes an existing gateway's service binding, including
for named GSV instances, so the adapter worker is reachable without public
adapter URLs or adapter tokens.

Deployment installs the transport but does not identify a WhatsApp sender. Pair
the linked device, send a direct message from the personal WhatsApp account to
the paired GSV number, and enter the returned link code in the web UI or with
`gsv auth link CODE`. Send one more message after linking; the code-request
message is not forwarded to an agent.

## Update

To update to the latest version of GSV, go back to [deploy.gsv.space](https://deploy.gsv.space) and run through the deploy flow again. It will update your existing instance in place — your data and configuration are preserved.

From the CLI:

```bash
gsv infra upgrade --all
```

Routine WhatsApp upgrades and unhealthy-transport reconnects keep the saved
linked-device authentication. They are not logout operations and do not require
scanning a new QR.

## Remove

Use the CLI for a complete removal:

```bash
gsv infra destroy --all --delete-bucket --purge-bucket
```

This deletes the GSV Workers and, when requested, the shared R2 data. It also
uninstalls the local gsvd service unless `--keep-device` is supplied. Review
the teardown prompt carefully because purged storage cannot be recovered.

To remove only the WhatsApp worker and its gateway binding while keeping GSV and
the local gsvd service:

```bash
gsv infra destroy -c channel-whatsapp --keep-device
```

Removing infrastructure does not itself press WhatsApp's in-app **Log out**
button. If you are retiring the account, disconnect it in GSV first so the
linked-device session is revoked, then remove the worker.

You can also remove resources manually from the Cloudflare dashboard:

1. Go to your [Cloudflare dashboard](https://dash.cloudflare.com)
2. Delete the GSV Workers (under **Workers & Pages**)
3. Delete the Durable Object namespaces (under **Workers & Pages → Durable Objects**)
4. Delete the KV namespaces if any were created (under **Workers & Pages → KV**)
5. Remove the API token you created for GSV if you no longer need it

## See also

- [Get Started](/get-started/) — first-run walkthrough
- [Connect Devices](/how-to/connect-devices)
- [FAQ](/get-started/faq)
