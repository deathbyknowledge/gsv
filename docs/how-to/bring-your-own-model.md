# Bring your own model

GSV ships with access to Cloudflare's models, so it works the moment you finish setup — no extra account, no key to paste. That's the fastest way to start.

For everyday use, we recommend connecting your own provider key. You'll get better speed, more reliable responses, and your pick of model. Think of the built-in Cloudflare models as the on-ramp, not the destination.

## Add a model

1. Go to **GSV → Settings → Models → New model.**
2. Follow the instructions for your provider and paste your key.
3. Make it **primary** so your agents try it first.

You can keep several complete model configurations. Their order is their fallback order, and an agent or Process can prefer any entry by its stable ID.

Cloudflare's available models are listed at [developers.cloudflare.com/workers-ai/models](https://developers.cloudflare.com/workers-ai/models).
## See also

- [Get Started](/get-started/)
- [FAQ](/get-started/faq)
