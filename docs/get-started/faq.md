# Frequently Asked Questions

## What this is

### What is GSV?

GSV is a personal AI computer, or for technical readers, a distributed OS with AI in the kernel. It runs across the devices you already own and treats them as one machine, with the "brain" living on Cloudflare's edge rather than on any single box. It isn't a chatbot and isn't a single-box agent. It's a computer you talk to that can act on your laptop, your server, and your phone as one system.

### How is this different from a single-box agent?

Most self-hosted assistants run as one agent on one host you pick and keep running: a laptop, a VPS, a container. That's one brain in one place. GSV is distributed, so it's one mind across every device you own, not stuck on any single one. The brain runs on the edge and remains reachable even when your machines are asleep; durable state survives hibernation and cold starts. Where the brain runs is the core difference.

See [Architecture Overview](/architecture/) for a deeper look at how the pieces fit together.

### Who is this for right now?

Today, GSV is for people who run more than one machine and want an AI that spans all of them: the privacy-conscious, multi-machine, self-hosting crowd. The longer-term goal is a personal AI computer anyone can use with no setup skills, but that's the direction, not where we are at launch. If you're comfortable connecting a Cloudflare account and a couple of devices, you're in the right place today.

## Cost and requirements

### What does it cost?

GSV can run within Cloudflare's Workers Free plan, plus whatever your chosen
model provider charges. There is no GSV subscription today. Workers Paid is
optional for paid-only capabilities such as Worker Loaders/CodeMode and for
usage beyond the Free limits.

One continuously connected WhatsApp account is the intended Free-plan baseline.
Its outbound WebSocket keeps one 128 MB Durable Object resident for much of the
day, using about 11,060 GB-s of the current 13,000 GB-s daily allowance. That is
an estimate rather than a capacity guarantee because other active Durable
Objects count too. Several always-connected accounts can exceed the duration
allowance even when request counts remain low. Cloudflare publishes the current numbers in its
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

### Do I need a paid Cloudflare plan?

No. GSV uses SQLite-backed Durable Objects, which Cloudflare supports on Workers
Free. Containers are not part of the supported deployment. Choose Workers Paid
when you want CodeMode or need more runtime capacity; the deployer automatically
omits the paid-only Worker Loader binding on Free accounts.

### What do I need to run it?

A Cloudflare account and at least one device to connect. The Free plan is enough
for the baseline deployment. If you do not want to use Cloudflare Workers AI,
you can bring your own model-provider keys.

## Open, private, yours

### Is it really open source?

Yes. GSV is MIT-licensed and the full source is public at [github.com/deathbyknowledge/gsv](https://github.com/deathbyknowledge/gsv). Don't take our word for any of this. Read every line.

### Can I self-host it off Cloudflare?

Not yet, to be exact: GSV is open source today (MIT, all the code is there) and runs in your own Cloudflare account today (your keys, your data). Running it fully off Cloudflare, on your own metal, is on the roadmap. It's technically possible, but not supported or recommended yet.

### Where does my data go?

Into your own Cloudflare account. Your keys, your data, never routed through us. We don't host your instance and we're not in the path of your data.

### Is anything exposed to the internet?

No open ports, no VPN, no box sitting exposed. Your devices connect outbound through the gateway using tokens, so nothing comes inbound to your machines. Only your GSV URL is public, everything else is private.

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

### Can I use it from WhatsApp, Telegram, or Discord?

GSV is designed to be reachable from the messengers you already use, so you can talk to it from wherever you are.

WhatsApp needs a second number, but not necessarily a second phone: current
WhatsApp versions support two accounts on one compatible Android or iOS phone.
Pairing uses a private Linked Devices QR code. The adapter is built on the
unofficial Baileys client, so WhatsApp protocol changes can occasionally require
a GSV update or fresh link.

See [Messengers](/how-to/messengers) for how to connect each one.

### What can it actually do today?

GSV runs agents as real OS processes and is programmable through skills, integrations, and connected machines. It's early, so expect a focused set of capabilities now and more arriving in the open.

See [Examples](/examples/) for more.

## Status and trust

### Is this production-ready? What's the catch?

GSV is early. We're launching in the open, at the ground floor. The honest catch: it's the newest of its kind, so there's less polish and no big ecosystem yet. What you get in exchange is an architecture nobody else has and a chance to shape it. If you want something finished and hands-off, we're not there yet. If you want to be early on the right design, you're in the right place.

### How do I get help, report a bug, or contribute?

Join the [Discord](https://discord.gg/hy9ExJJFvn) for help and community, and file issues or PRs on GitHub at [github.com/deathbyknowledge/gsv](https://github.com/deathbyknowledge/gsv). Contributions welcome. It's open from the ground up.

### Why "GSV"?

It's named for the General Systems Vehicles in Iain M. Banks' Culture novels, vast ship-Minds that look after their crew. GSV is the Mind on the edge; your devices are the crew.

## See also

- [Get Started](/get-started/)
- [Deploy / Update / Remove](/how-to/deploy)
- [Architecture Overview](/architecture/)
