# Contributing to GSV

## Setup

**Prerequisites:** [Rust](https://rustup.rs) · [Node.js](https://nodejs.org) v20+ · Cloudflare account (Workers Paid)

```bash
git clone https://github.com/deathbyknowledge/gsv.git
cd gsv
./scripts/setup-deps.sh   # install JS deps
npm run dev               # start local dev stack
cd cli && cargo build --release  # build CLI
```

## Making changes

For anything beyond a small fix, open an issue first so we can align before you write code.

1. Fork and branch from `main`
2. Make your changes and run tests (`npm test` / `cargo test`)
3. Open a PR with a short description and link any related issues

## Security

Don't open public issues for vulnerabilities — email [security@humansandmachin.es](mailto:security@humansandmachin.es) instead.
