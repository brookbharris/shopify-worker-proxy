# Contributing

Thanks for your interest in improving `shopify-worker-proxy`. This is a small, focused project — the goal is to keep the lite Worker minimal and reliable. Pull requests that grow the surface area significantly may be redirected to the Pro bundle instead.

## How to contribute

### Reporting a bug

Open an [Issue](https://github.com/brookbharris/shopify-worker-proxy/issues) using the **Bug Report** template. Include:
- What you tried (curl command, code snippet, or steps)
- What you expected to happen
- What actually happened (full error message and HTTP status)
- Your Wrangler version (`wrangler --version`) and Worker logs if available

Please **never paste your `SHOPIFY_CLIENT_SECRET` or `WORKER_SECRET`** in an issue. If a stack trace contains one, redact it.

### Suggesting a feature

Open an [Issue](https://github.com/brookbharris/shopify-worker-proxy/issues) using the **Feature Request** template. Note that:
- Features that **fix bugs or improve the existing Shopify endpoints** are welcome in the lite version
- Features that **add new upstream services** (other APIs, more integrations) likely belong in the Pro bundle
- Either way, ask first before writing code — saves you time

### Submitting a pull request

1. Fork the repo and create a branch from `main`
2. Keep the change focused — one logical change per PR
3. Test locally with `wrangler dev` before pushing
4. Open the PR with a clear description of what changed and why
5. Be patient — this is maintained by one person on the side

By submitting a PR, you agree your contribution will be released under the project's [MIT license](LICENSE).

## What this project is — and isn't

**It is:** a focused Cloudflare Worker that handles the Shopify 2026 client credentials OAuth flow and exposes a handful of structured product and page endpoints.

**It isn't:** a full Shopify SDK, an embedded app framework, a no-code platform, or a general-purpose API gateway. If you need those, there are better tools.

## Maintainer

[Brook Harris](https://github.com/brookbharris) — nonprofit operations professional building tools for small Shopify stores. Not a career developer; built this with AI coding help. Patience appreciated on technical deep-dives.
