# Frequently Asked Questions

## What this is

### What is Ship?

Ship is an open-source personal AI assistant, built in Europe, for the things
you keep meaning to do. You tell it what needs doing in your browser, on WhatsApp or on Telegram. It
researches options, uses the tools and accounts you connect, checks with you
before anything important, and follows up until the job is done.

### How are Ship and GSV related?

Ship is the product: the personal AI assistant you talk to. GSV is the
open-source stack underneath it, and what these docs describe: a distributed
operating environment where agents are durable processes that act across the
devices you connect, with the control plane on Cloudflare's edge rather than on
any single box. The hosted Ship at [ship.space](https://ship.space) runs on GSV,
and anyone can deploy GSV to run their own Ship.

GSV keeps its name in technical identifiers: the `deathbyknowledge/gsv`
repository, the `gsv` CLI command, the `gsv` target and `.gsv` folders. Earlier
releases also used GSV as the product name. Your conversations, files, settings
and connected machines do not need to move.

An operator may add a new public domain while keeping an existing address as an
alias to the same installation. Use the address your operator provides; a new
browser origin may require signing in again. Existing federation identities and
contacts are preserved.

### How is Ship different from other self-hosted AI agents?

Most self-hosted assistants run as one agent on one host you pick and keep running: a laptop, a VPS, a container. That's one brain in one place. Ship runs on GSV, which is distributed, so it's one mind across every device you own, not stuck on any single one. The brain runs on the edge and remains reachable even when your machines are asleep; durable state survives hibernation and cold starts. Where the brain runs is the core difference.

See [Architecture Overview](/architecture/) for a deeper look at how the pieces fit together.

### Who is this for right now?

Anyone who wants help with everyday tasks can create a Ship at
[ship.space](https://ship.space) with no setup and no API key. Self-hosting suits
people who want their Ship's state in their own Cloudflare account and are
comfortable deploying Workers and connecting a couple of devices.

## Cost and requirements

### What does it cost?

Hosted Ship at [ship.space](https://ship.space) is free during early access.
Purchases and third-party services are paid separately. Other operators set
their own pricing. Self-hosting uses your own Cloudflare account and
model-provider billing. The public operator composition
includes CodeMode's Worker Loader and requires
[Workers Paid](https://developers.cloudflare.com/dynamic-workers/pricing/).
Usage beyond the plan's allowances and model inference are billed separately.

### Do I need a paid Cloudflare plan?

For self-hosting, yes: the current public composition with CodeMode requires
Workers Paid. It does not silently omit the Worker Loader on Free accounts.
Containers are not required. Using hosted Ship at ship.space does not require
your own Cloudflare account.

### What do I need to run it?

A Cloudflare account, a domain in one of its DNS zones, and Node.js and Rust
for the source build. Follow the [deployment guide](/how-to/deploy-with-alchemy).
If an operator hosts your Ship, sign up with them or use their setup invitation.
Connect machines when you want Ship to work on them.

## Open, private, yours

### Is it really open source?

Yes. Ship is built on GSV, whose runtime, Accounts, inference execution and
deployment components are MIT-licensed and public at [github.com/deathbyknowledge/gsv](https://github.com/deathbyknowledge/gsv).
Operators may keep commercial services private; those services are not required
to run your own deployment.

### Can I self-host it off Cloudflare?

Not yet, to be exact: Ship is open source today (MIT, all the code is there) and runs in your own Cloudflare account today (your keys, your data). Running it fully off Cloudflare, on your own metal, is on the roadmap. It's technically possible, but not supported or recommended yet.

### Where does my data go?

Your Ship's state lives in its operator's Cloudflare account. With self-hosting,
that is your account. Model providers and connected messengers receive the data
routed to them. The public stack works without routing through H&M services.

If you sign up from a link on ship.space or from one of our ads, Accounts
reports which part of the page the link was on, as one of a few fixed
placements, for an example card which example, and the ad campaign's own
source and name. It is reported once, as `installation.attributed`, when your
Ship is reserved, and nothing about it is kept afterwards. It never includes
who you are, the link's own wording or an ad network's click id; anything
outside the fixed list is reported as `other` or dropped.

### Is anything exposed to the internet?

No open ports, no VPN, no box sitting exposed. Your devices connect outbound through the gateway using tokens, so nothing comes inbound to your machines. Only your Ship URL is public, everything else is private.

See [Security Model](/architecture/security-model) for the full picture.

## How it works

### How do I connect a device?

Connecting a device is a quick per-device step. See the [Connect Devices](/how-to/connect-devices) guide.

### Does it keep running when my devices are off?

The gateway remains reachable on the edge even when every device is asleep.
Durable state survives hibernation, eviction, and cold starts, and adapter
connections are recreated when needed. Work that requires a specific device,
such as a file that exists only on a sleeping laptop, waits until that device is
back online.

### Which models can I use?

Bring your own. You can connect your own model provider with your own API key, or use the built-in Cloudflare Workers AI one.

See [Bring Your Own Model](/how-to/bring-your-own-model) for setup instructions.

### Can I use it from Telegram, Discord, Slack, or WhatsApp?

Yes, when your operator enables the adapter and supplies its application
credentials. Link your own identity from Settings → Messengers. One external
identity has one active Ship for each private-message adapter route.

WhatsApp works through an operator-owned WhatsApp Business number where Meta
permits it. Meta does not let a business number message across the borders of
Brazil or Indonesia, so a Ship number registered elsewhere is not offered in
those countries. See
[Messengers](/how-to/messengers) for the supported flows.

### What can it actually do today?

Ship runs agents as real OS processes and is programmable through skills, integrations, and connected machines. It's early, so expect a focused set of capabilities now and more arriving in the open.

See [Examples](/examples/) for more.

## Status and trust

### Is this production-ready? What's the catch?

Ship is early. We're launching in the open, at the ground floor. The honest catch: it's the newest of its kind, so there's less polish and no big ecosystem yet. What you get in exchange is an architecture nobody else has and a chance to shape it. If you want something finished and hands-off, we're not there yet. If you want to be early on the right design, you're in the right place.

### How do I get help, report a bug, or contribute?

Join the [Discord](https://discord.gg/hy9ExJJFvn) for help and community, and file issues or PRs on GitHub at [github.com/deathbyknowledge/gsv](https://github.com/deathbyknowledge/gsv). Contributions welcome. It's open from the ground up.

### Why "Ship"?

It's named for the General Systems Vehicles in Iain M. Banks' Culture novels, vast ship-Minds that look after their crew. Ship is the Mind on the edge; your devices are the crew.

## See also

- [Get Started](/get-started/)
- [Deploy / Update / Remove](/how-to/deploy)
- [Architecture Overview](/architecture/)
