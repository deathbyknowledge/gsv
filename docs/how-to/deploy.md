# Deploy, Update, and Remove

## Deploy

Go to [deploy.gsv.space](https://deploy.gsv.space) and follow the steps. It connects your Cloudflare account, provisions the required Workers and Durable Objects, and leaves you with a running GSV instance.

You will need:

- A Cloudflare account
- Your Cloudflare API token (the deploy tool will walk you through creating one with the right permissions)

Once complete, your GSV instance is live and reachable via the CLI or any adapter you connect.

## Update

To update to the latest version of GSV, go back to [deploy.gsv.space](https://deploy.gsv.space) and run through the deploy flow again. It will update your existing instance in place — your data and configuration are preserved.

## Remove

To remove GSV from your Cloudflare account you need to do this manually from the Cloudflare dashboard for now.

1. Go to your [Cloudflare dashboard](https://dash.cloudflare.com)
2. Delete the GSV Workers (under **Workers & Pages**)
3. Delete the Durable Object namespaces (under **Workers & Pages → Durable Objects**)
4. Delete the KV namespaces if any were created (under **Workers & Pages → KV**)
5. Remove the API token you created for GSV if you no longer need it

We are working on a one-click removal tool — this will be available soon.

## See also

- [Get Started](/get-started/) — first-run walkthrough
- [Connect Devices](/how-to/connect-devices)
- [FAQ](/get-started/faq)
