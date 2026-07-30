# Get Started

Get a GSV running in your own Cloudflare account and have your first conversation with it. Budget around five minutes — most of it is waiting on a deploy.

## Before you start

You'll need:

- A **Cloudflare account**. Workers Free supports the baseline GSV deployment;
  Workers Paid is optional for CodeMode and additional runtime capacity.
- **R2 object storage** enabled. The free tier is enough to start.
- A **model**. Cloudflare's own models work out of the box; you can swap in another provider's key later. For everyday use we recommend bringing your own provider key — see Bring your own model.

Infrastructure can fit within Cloudflare's Free limits, plus whatever your model
usage costs. A continuously connected WhatsApp account uses most of the Free
Durable Object duration allowance; see the [FAQ](/get-started/faq) before adding
several accounts.

> GSV runs in *your* Cloudflare account — not on our servers. Full self-hosting off Cloudflare (on your own metal) is on the roadmap, not shipped yet.

## 1. Set up Cloudflare

1. Create an account at [cloudflare.com](https://cloudflare.com).
2. Enable storage: **Build → Storage & databases → R2 Object Storage → Overview → Get free subscription.**
3. Optionally choose Workers Paid if you want CodeMode or expect to exceed the
   Free runtime limits. Containers are not required.

## 2. Deploy GSV

1. Go to [deploy.gsv.space](https://deploy.gsv.space), sign in, and follow the prompts.
2. Leave the **Discord** and **Telegram** credential fields empty for now — you
   can connect those later. WhatsApp is paired after deployment with a private
   Linked Devices QR code. Keep the channel workers selected, or add them later.
3. The deploy takes about two minutes.
4. When it finishes, click **Open GSV Setup.**

## 3. Run setup

1. Choose **Quick start** to get going fast, or **Custom** to change the default AI or the repository GSV clones from. Both are changeable later, so Quick start is fine for a first run.
2. Enter a **username**, an optional **name for your personal agent**, and a **password.**
3. Optionally set a separate password for admin tasks, and pick your **timezone.**
4. Start setup — it takes a minute or so.
5. When your workspace is ready, **copy the commands it shows you and run them in your terminal** before opening the desktop.

That's it — you have your own GSV.

## 4. Look around

- Click the **GSV circle** (top) for your files, library, terminal, and settings.
- **Machines** — the devices connected to your GSV, and where you add new ones (laptop, phone, server).
- **Messengers** — your connections to WhatsApp, Telegram, Discord, and more to come.
- **Integrations** — your MCP servers.
- Click your **personal agent** (bottom right) to start chatting. Ask it what it can do.

## Next steps

Now that GSV is running:

- [Connect your devices](/how-to/connect-devices) — turn your laptop, phone, and server into one computer.
- [Bring your own model](/how-to/bring-your-own-model) — use a provider key instead of the Cloudflare default.
- [Connect a messenger](/how-to/messengers) — talk to GSV from WhatsApp, Telegram, or Discord.
- [Add integrations](/how-to/integrations) — wire in MCP servers.
- [Web access](/how-to/browse-web) — let your agent browse your web like you can.
- [Examples](/examples/index) — see some examples on how to use GSV.
- [FAQ](/get-started/faq) — common questions about cost, devices, memory, and more.
