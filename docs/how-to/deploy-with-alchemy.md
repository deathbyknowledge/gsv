# Deploy GSV with Alchemy

The public Alchemy stack deploys a standalone, user-owned GSV into your
Cloudflare account. It creates the Gateway, R2 storage, ripgit, and the selected
adapter Workers from the release manifest generated from each adapter's
`adapter.json`.

```bash
npm ci
npx alchemy login
npx alchemy cloudflare bootstrap
npm run deployment:plan
npm run deployment:deploy
```

The default includes every bundled adapter. Select a subset without changing
source:

```bash
GSV_ADAPTERS=telegram,discord npm run deployment:plan
GSV_ADAPTERS=telegram,discord npm run deployment:deploy
```

Adapter credentials are entered through GSV after deployment and remain owned
by the adapter. The deployment stack provides Telegram its stable Worker URL
for webhook registration; it does not put a bot token in source or Alchemy
state.

The stack state is independent from a managed GSV operator. Do not point this
stack and another deployment owner at the same Worker names or retained state.
