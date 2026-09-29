# Bring your own model

GSV ships with access to Cloudflare's models, so it works the moment you finish setup — no extra account, no key to paste. That's the fastest way to start.

For everyday use, we recommend connecting your own provider key. You'll get better speed, more reliable responses, and your pick of model. Think of the built-in Cloudflare models as the on-ramp, not the destination.

## Add a model

1. Open **Settings → preferences** and click **add model** under **Model order.**
2. Enter your provider's details and key, then save.
3. Click **use first** on the new entry so your agents try it first.

The list under **Model order** is the fallback order: the top entry is labelled **First choice** and the rest **Fallback 1**, **Fallback 2**, and so on. The first model is tried first; if it cannot complete the reply, the next model takes over. Drag a row, or use the arrows, to reorder. Each row's **details** shows how it connects, its endpoint, and its output and context limits.

Your models are stored at `users/{uid}/ai/models`, layered ahead of the installation list at `config/ai/models` and the deployment's base models; see the [configuration reference](/reference/configuration#ai-model-config). An agent or Process can prefer any entry by its stable ID.

Cloudflare's available models are listed at [developers.cloudflare.com/workers-ai/models](https://developers.cloudflare.com/workers-ai/models).
## See also

- [Get Started](/get-started/)
- [FAQ](/get-started/faq)
