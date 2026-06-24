# GSV — Frequently Asked Questions

---

## What even is this?

**Is GSV an AI chatbot?**
Not exactly. GSV is more like a personal AI computer — an operating system where AI agents run as processes on your own cloud infrastructure. Think less "chat with a bot" and more "a crew of AI that lives on your system, knows your context, and works on your behalf."

**What's the difference between GSV and ChatGPT, Claude, or other AI assistants?**
Those are AI services run by companies on their servers. GSV is infrastructure you own and deploy yourself. Your data doesn't go to our servers. The AI runs in your Cloudflare account (or locally), not ours. You also get persistent agents that remember you across conversations and can take actions — not just answer questions.

**What does "personal AI computer" actually mean?**
It means AI that's part of your system, not a product you log into. GSV unifies your devices, gives agents access to your files and shell, lets them connect to services like email or calendar, and manages everything through an interface that's yours — not a platform's.

**What happens when my laptop is closed — does GSV stop working?**
No. This is one of the core things that makes GSV different. GSV's brain runs on Cloudflare's edge network, not on your machine. So even when every device you own is asleep, your agents are still reachable, still running, and can still act. When your devices wake back up, they reconnect automatically.

**Why is it called GSV?**
GSV stands for General Systems Vehicle — the name for the enormous, planet-scale sentient ships in Iain M. Banks' *Culture* science fiction series. Those ships are self-aware, independent, and work on behalf of the people aboard them. That's the spirit we're building toward: AI that's genuinely yours, not a service you're renting.

---

## Setup & Cost

**Do I need technical skills to use GSV?**
For the cloud-hosted version, the goal is no — if you can follow a setup guide, you should be able to get running. That said, we're in beta, and some rough edges exist. The self-hosted version currently requires comfort with a terminal. We're working on making both easier.

**What does it cost to run?**
GSV itself is free and open source. Running it requires a Cloudflare Workers Paid plan (~$5/month) for the cloud deployment. You'll also need API keys for whichever AI models you want to use (e.g. Anthropic, OpenAI) — those are billed directly by the model provider based on usage. There's no GSV subscription fee.

**Do I bring my own AI API keys?**
Yes. GSV doesn't bundle a model — you connect your own. This keeps you in control of which models you use and what you spend.

**Can I try it without a Cloudflare account?**
Not yet for the cloud version. A fully local setup doesn't require Cloudflare, but it's currently more technical to configure. We're working on a simpler onboarding path.

---

## Privacy & Control

**Who can see my data?**
Nobody at Humans & Machines can see your data. When you deploy GSV, it runs entirely inside your own Cloudflare account. Your files, conversations, and agent history live there — not on our servers.

**Can I run it with no cloud at all?**
Yes. GSV can be self-hosted locally. The cloud deployment on Cloudflare is the easier path, but the open-source codebase supports local hosting for those who want full air-gap control.

**What's the difference between the cloud and self-hosted options?**
Cloud (Cloudflare) means your GSV runs on Cloudflare's global edge network — fast, always on, accessible from anywhere, but requires a Cloudflare account. Self-hosted means you run it on your own machine or server — fully private, no third-party infrastructure, but you manage uptime and access yourself.

---

## Open Source

**What license is GSV under?**
MIT. Use it, fork it, build on it.

**Can I contribute?**
Yes — the repo is open at [github.com/deathbyknowledge/gsv](https://github.com/deathbyknowledge/gsv). Issues, pull requests, and feedback are all welcome. Join the conversation on [Discord](https://discord.gg/hy9ExJJFvn) too.

**Is the whole thing open source, or just part of it?**
The entire core is open source. What you see on GitHub is what powers GSV — there's no proprietary backend hiding behind it.

---

## What GSV Can Do

**What can GSV handle out of the box?**
At launch, GSV ships with built-in agents that can manage email, scheduling, and general life admin. It can also access your connected devices — reading and writing files, running shell commands — and connect to external services via adapters like WhatsApp, Discord, and Telegram.

**What are agents, processes, and adapters?**
GSV borrows the mental model of an operating system. *Agents* are AI that run as *processes* — they have persistent memory, identities, and can be spawned, messaged, or stopped like programs on a computer. *Adapters* are connectors to external surfaces (WhatsApp, Telegram, etc.) — think of them like device drivers that let your agents send and receive messages wherever you already are.

**Can GSV access my email, calendar, and files?**
Yes, that's the core use case. GSV agents can read and act on connected services. Email, scheduling, and file access on connected devices are supported. More integrations are being added — see the GitHub repo for current adapter support.

**Can I build my own apps or agents on top of GSV?**
Yes — and this is where GSV differs from tools like OpenClaw or Hermes. Those are agents you can customize; GSV is a computer you can program. It has its own application layer with an SDK, so you can write packages, build apps, and share them with other GSV instances through a built-in git remote. Think of it less like configuring a chatbot and more like writing software for a platform.

---

## How does GSV compare to the alternatives?

**What's the difference between GSV, OpenClaw, Hermes, and Zo?**
The short version: OpenClaw and Hermes are self-hosted AI agents that run on a single machine you keep switched on. Zo is a polished hosted AI computer, but it runs on their servers, not yours. GSV is the only one that's distributed — your agents run on Cloudflare's edge and can act across all your devices at once, even when those devices are off.

|  | GSV | OpenClaw | Hermes | Zo |
|---|---|---|---|---|
| **What it is** | Personal AI cloud computer connecting all your devices | Self-hosted agent on one box | Self-improving agent on one box | Hosted personal AI cloud computer |
| **Brain runs on** | Cloudflare edge (yours) | Your machine / VPS | Your VPS / serverless | Their cloud |
| **On when devices are off?** | Yes | Only if the box stays on | If on a VPS | Yes |
| **Spans all your devices?** | Yes — laptop + server + Pi together | No — single host | No — single host | No — it is the box |
| **Who owns the infra** | You (your Cloudflare account) | You | You | Them |
| **Open source** | Yes (MIT) | Yes | Yes (MIT) | No |
| **Real monthly cost** | ~$5 | Your VPS (~$5+) | Your VPS (~$5) | Free tier + paid credits |
| **Programmable / app layer** | Yes | No | No | No |
| **Best for** | Multi-machine self-hosters | Tinkerers wanting max agent skills | Model tinkerers, learning-loop fans | Non-technical users |

**If OpenClaw and Hermes are popular, why would I switch?**
They're great single-machine agents. If you only have one machine and want to keep it simple, they work well. GSV is for when that hits its limits: you have more than one machine, you want your AI on even when your laptop is closed, or you want to build and share apps — not just configure agent tools. GSV is closer to a computer than an agent.

**Is GSV more technical to set up than Zo?**
Currently yes — Zo has a polished onboarding since it's a hosted product. GSV requires a Cloudflare account and a short deploy step. The trade-off is that with Zo, you're renting space on their infrastructure; with GSV, you own it outright.

---

## Still have questions?

- Join the [Discord](https://discord.gg/hy9ExJJFvn)
- Follow us on [X / @humachinesinc](https://x.com/humachinesinc)
- Read the code on [GitHub](https://github.com/deathbyknowledge/gsv)
- Email us at [hello@humansandmachin.es](mailto:hello@humansandmachin.es)