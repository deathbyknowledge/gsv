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

Hosted spaces use their operator's pricing. Self-hosting uses your own
Cloudflare account and model-provider billing. The public operator composition
includes CodeMode's Worker Loader and requires
[Workers Paid](https://developers.cloudflare.com/dynamic-workers/pricing/).
Usage beyond the plan's allowances and model inference are billed separately.

### Do I need a paid Cloudflare plan?

Yes, for the current public composition with CodeMode. It does not silently
omit the Worker Loader on Free accounts. Containers are not required.

### What do I need to run it?

A Cloudflare account, a domain in one of its DNS zones, and Node.js and Rust
for the source build. Follow the [deployment guide](/how-to/deploy-with-alchemy).
If an operator hosts your space, you only need its setup invitation. Connect
machines when you want GSV to work on them.

## Open, private, yours

### Is it really open source?

Yes. The GSV runtime, Accounts, inference execution and deployment components
are MIT-licensed and public at [github.com/deathbyknowledge/gsv](https://github.com/deathbyknowledge/gsv).
Operators may keep commercial services private; those services are not required
to run your own deployment.

### Can I self-host it off Cloudflare?

Not yet, to be exact: GSV is open source today (MIT, all the code is there) and runs in your own Cloudflare account today (your keys, your data). Running it fully off Cloudflare, on your own metal, is on the roadmap. It's technically possible, but not supported or recommended yet.

### Where does my data go?

Your space's state lives in its operator's Cloudflare account. With self-hosting,
that is your account. Model providers and connected messengers receive the data
routed to them. The public stack works without routing through H&M services.

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

### Can I use it from Telegram, Discord, or Slack?

Yes, when your operator enables the adapter and supplies its application
credentials. Link your own identity from Settings → Messengers. One external
identity has one active space for each private-message adapter route.

The previous WhatsApp linked-device adapter is removed. WhatsApp Business is
planned separately. See [Messengers](/how-to/messengers) for the supported flows.

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
