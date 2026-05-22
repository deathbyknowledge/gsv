# Set Up Cloudflare for GSV

Use this page if you need to prepare a Cloudflare account before deploying GSV.
If your account already has Workers, Durable Objects, R2, and a usable API
token, go back to [Get Started](./).

Cloudflare Pages is **not required** for the core GSV deployment.

## What You Need

You need:

- a Cloudflare account
- access to Workers and Durable Objects
- R2 enabled for the target account
- an API token that can deploy Workers and manage R2

## 1. Create or Open Your Cloudflare Account

If you do not already have an account, sign up at:

- <https://dash.cloudflare.com/sign-up>

Then open the Cloudflare dashboard for the account you want to use for GSV.

## 2. Enable the Required Products

In the Cloudflare dashboard:

1. Open **Workers** in the Cloudflare dashboard to initialize the Workers environment.
2. Open **R2** and complete the initial setup if R2 is not enabled yet.
3. Make sure the account can use **Durable Objects**.

## 3. Create an API Token

1. Open your profile in the top-right corner.
2. Go to **My Profile**.
3. Open **API Tokens**.
4. Choose **Create Token**.
5. Start from the **Edit Cloudflare Workers** template.

Use a clear name such as `GSV deploy token`.

## 4. Grant the Token Permissions

Under **Permissions**, use the **Edit Cloudflare Workers** template as the
starting point, then make sure the token also has the R2 access needed for your
deployment.

For the core GSV deployment, the important capabilities are:

- permission to edit Cloudflare Workers
- permission to manage the target R2 storage

If the template does not already include the R2 access you need, add it before
creating the token.

Cloudflare Pages is not needed for the core GSV deployment.

## 5. Scope the Token to the Right Account

Under **Account Resources**, either:

- include the specific account you will deploy into, or
- include all accounts if you truly need that scope

Prefer the specific account when possible.

## 6. Save the Token Securely

Create the token and copy it immediately. Cloudflare will not show the full raw
value again. You will also need the Cloudflare account id for the account you are
deploying into.

Store it in a password manager or your shell environment, for example:

```bash
export CF_API_TOKEN="..."
export CF_ACCOUNT_ID="..."
```

Then save it for GSV if you want:

```bash
gsv config --local set cloudflare.api_token "$CF_API_TOKEN"
gsv config --local set cloudflare.account_id "$CF_ACCOUNT_ID"
```

## Security Notes

Treat this token like deployment-level infrastructure access. Anyone who holds it
can modify the deployed GSV components in the scoped account.

## See also

- [Get Started](./)
- [How to Deploy GSV](../how-to/deploy.md)
- [Configuration Reference](../reference/configuration.md)
