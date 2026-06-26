# FAQ

## What is GSV?

GSV is a personal AI computer that runs across all your devices. It keeps a single agent alive as a long-lived process in the cloud, so your agent persists between conversations, across machines, and while your devices are off.

## Do I need a server?

No. GSV runs entirely on your own Cloudflare account using Cloudflare Workers and Durable Objects. There is no server to manage.

## Is it free to run?

GSV itself is open-source. You pay only for Cloudflare usage and your LLM.

## What do I need to get started?

A Cloudflare account and about five minutes. See [Deploy GSV](/how-to/deploy).

## What is an adapter?

Adapters are how you reach GSV from different surfaces — the CLI, a chat app like WhatsApp or Discord, or a custom client. They route into the same agent process and shared state. See [Connect a Messenger](/how-to/messengers).

## What is a device?

A device is any machine running the GSV daemon (`gsvd`). Devices register with the cloud and expose their local tools — filesystem, processes, hardware — to the agent. See [Connect Devices](/how-to/connect-devices).

## What is a package?

Packages are installable extensions that add capabilities to GSV: browser apps, backend logic, CLI commands, and package-scoped storage. See [Applications](/how-to/applications).

## Can I run multiple agents?

Yes. GSV supports multiple named processes. Each is a durable agent with its own context and lifecycle.

## Where does the agent's memory live?

Context is stored in Cloudflare Durable Objects. See [Context and Knowledge](/architecture/context-and-knowledge) and [Context Compaction](/architecture/context-compaction) for how long-running memory is managed.

## Is GSV open-source?

Yes. The source is on [GitHub](https://github.com/deathbyknowledge/gsv).

## See also

- [Get Started](/get-started/)
- [Deploy / Update / Remove](/how-to/deploy)
- [Architecture Overview](/architecture/)