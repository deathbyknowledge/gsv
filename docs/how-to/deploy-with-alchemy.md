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

## Existing standalone Wrangler deployments

The Gateway package's `dev` and `start` commands run both the Gateway and its
standalone inference companion. The `deploy` command deploys the companion first,
then the Gateway. Both retain the existing `singleton` identity and storage names;
the companion owns the native Workers AI binding.

```bash
GSV_GATEWAY_ORIGIN=https://your-existing-gsv.example.com npm run deploy --workspace gateway
```

Set the exact existing Gateway HTTPS origin, without a trailing slash. The
companion's directory uses that origin and admits only `singleton`; it has no
public endpoint. Use these package commands instead of deploying the Gateway
alone with raw Wrangler. Custom Worker names or environments belong in an
explicit deployment composition, which must wire both Workers together.
