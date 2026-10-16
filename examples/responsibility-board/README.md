# Responsibility board example

A static, read-only app for the owner of the installation that publishes it.
The board lists current responsibilities, opens details and updates on
`r12y.changed`. It uses only `r12y.list` and `r12y.get` through the ordinary SDK.

From the repository root:

```sh
npm run gsv:build
node examples/responsibility-board/build.mjs
```

Publish `examples/responsibility-board/dist/` using the
[site publication workflow](../../docs/how-to/publish-site.md), with
`entry: "index.html"` and `routing: "static"`. The build uses relative asset URLs,
so it works under the chosen release directory. Record the source repository and
commit in the publication manifest; there are no embedded credentials or sample
private records.

`prepareSiteClient()` loads the reserved `/_gsv/site.json` route on the app's own
origin. Enable the Connect button after preparation and call `connect()` directly
from its click handler. The helper opens the trusted installation's consent page,
validates the popup response, and returns an ordinary `GSVClient`. The example
does not accept a gateway address or discover other spaces.

Anonymous visitors see the sign-in screen. The publishing owner can approve a
session lasting up to one hour. The helper keeps its credential in memory and
closes on expiry; the board clears displayed responsibilities when disconnected.
There is no credential refresh or persisted login. Revocation happens in the
owner's existing token settings. A new connection requires another consent click.
