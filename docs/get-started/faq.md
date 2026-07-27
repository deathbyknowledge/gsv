# Frequently Asked Questions

## What this is

### What is GSV?

GSV is a personal AI computer, or for technical readers, a distributed OS with AI in the kernel. It runs across the devices you already own and treats them as one machine, with the "brain" living on Cloudflare's edge rather than on any single box. It isn't a chatbot and isn't a single-box agent. It's a computer you talk to that can act on your laptop, your server, and your phone as one system.

### How is this different from a single-box agent?

Most self-hosted assistants run as one agent on one host you pick and keep running: a laptop, a VPS, a container. That's one brain in one place. GSV is distributed, so it's one mind across every device you own, not stuck on any single one. The brain runs on the edge and stays awake, so it's reachable even when your machines are asleep, and it can act across all of them at once. Where the brain runs is the core difference.

See [Architecture Overview](/architecture/) for a deeper look at how the pieces fit together.

### Who is this for right now?

Today, GSV is for people who run more than one machine and want an AI that spans all of them: the privacy-conscious, multi-machine, self-hosting crowd. The longer-term goal is a personal AI computer anyone can use with no setup skills, but that's the direction, not where we are at launch. If you're comfortable connecting a Cloudflare account and a couple of devices, you're in the right place today.

## Cost and requirements

### What does it cost?

About $5/month for infrastructure (a Cloudflare Workers Paid plan), plus your own model costs. You can bring your own API keys, so you pay your model provider directly for what you use. You can also use models through Cloudflare. There's no GSV subscription on top of that today.

### Why do I need a paid Cloudflare plan?

GSV's brain runs as an always-on process on Cloudflare's edge, which requires the Workers Paid plan (~$5/mo). We'd rather tell you this upfront than surprise you. It's the one hard requirement, and it's what makes the always-on, runs-in-your-own-account model work.

### What do I need to run it?

A Cloudflare account on the Workers Paid plan and at least one device to connect. If you don't want to go through Cloudflares Workers AI, you can also bring your own API keys.

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

The brain stays awake on the edge even when every device is asleep, so it's always reachable and can act on anything that doesn't need an offline machine. Work that requires a specific device, say a file that only lives on your sleeping laptop, waits until that device is back online. So it's always awake, not magically able to use hardware that's powered down.

### Which models can I use?

Bring your own. You can connect your own model provider with your own API key, or use the built-in Cloudflare Workers AI one.

See [Bring Your Own Model](/how-to/bring-your-own-model) for setup instructions.

### Can I use it from WhatsApp, Telegram, or Discord?

GSV is designed to be reachable from the messengers you already use, so you can talk to it from wherever you are.

See [Messengers](/how-to/messengers) for how to connect each one.

### What can it actually do today?

GSV runs agents as real OS processes and is programmable, so you can write, run, and share your own applications between GSV instances. It's early, so expect a focused set of capabilities now and more arriving in the open.

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
