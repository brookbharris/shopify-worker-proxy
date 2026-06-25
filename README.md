# shopify-worker-proxy

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Shopify 2026 OAuth](https://img.shields.io/badge/Shopify-2026%20OAuth-95BF47?logo=shopify&logoColor=white)](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials)
[![Issues](https://img.shields.io/github/issues/brookbharris/shopify-worker-proxy.svg)](https://github.com/brookbharris/shopify-worker-proxy/issues)
[![Stars](https://img.shields.io/github/stars/brookbharris/shopify-worker-proxy.svg?style=social)](https://github.com/brookbharris/shopify-worker-proxy/stargazers)

> **Shopify removed the static Admin API token in 2026.** This Cloudflare Worker is the missing piece — it does the new client credentials OAuth exchange for you, so your browser app or AI agent can push to Shopify without ever holding a credential.

```js
// Your browser app
await fetch("https://your-worker.workers.dev/shopify/sync/book", {
  method: "POST",
  headers: { Authorization: `Bearer ${WORKER_SECRET}` },
  body: JSON.stringify({ title: "My Product", price: "14.99" }),
});
// → { productId, handle, url, adminUrl, action: "created" }
```

That's it. No Shopify token in your code. No Node backend. Deploy once, call from anywhere.

---

## Why this exists

In January 2026, Shopify deprecated the "reveal Admin API access token" flow for custom apps. The API credentials tab no longer shows a static, copy-paste-able token. Instead, Shopify now requires apps to use the **client credentials grant** — you exchange a Client ID + Client Secret for a 24-hour access token, server-side, every time it expires.

That breaks every browser-based Shopify integration tutorial written before 2026, and it has no clean solution for AI agents, no-code builders, or any frontend tool that wants to talk to Shopify directly. You either spin up a backend, or you don't ship.

This Worker is the backend. It runs free on Cloudflare's edge, holds your credentials securely, refreshes the Shopify token on a 24-hour cycle automatically, and exposes a small set of structured endpoints your frontend can call with a single shared secret.

---

## How it works

```
┌─────────────────────────┐         ┌──────────────────────────┐         ┌─────────────────────┐
│  Browser app or         │         │  Cloudflare Worker       │         │  Shopify Admin API  │
│  AI agent               │  POST   │                          │  POST   │                     │
│                         │ ───────►│  - Holds credentials     │ ───────►│  Products / Pages   │
│  Authorization:         │         │  - Auto-fetches 24h      │         │                     │
│  Bearer <secret>        │         │    Shopify token         │         │                     │
└─────────────────────────┘         └──────────────────────────┘         └─────────────────────┘
        ▲                                       │
        │       structured JSON response        │
        └───────────────────────────────────────┘
```

Your app never sees `SHOPIFY_CLIENT_ID` or `SHOPIFY_CLIENT_SECRET`. The Worker holds them as encrypted Cloudflare Secrets, exchanges them for an access token the first time it needs one, caches that token for 24 hours, and refreshes it transparently when it expires.

---

## Compare to alternatives

| Approach | Holds Shopify creds in browser? | Backend to maintain? | Works with AI agents? | Cost |
|----------|---------------------------------|----------------------|-----------------------|------|
| Raw `fetch` from browser with static token | Yes (insecure) | No | Yes | Free — but Shopify removed static tokens |
| Roll your own Node/Express backend | No | Yes (server, hosting, monitoring) | Yes | $5–20/mo |
| Shopify CLI dev proxy | No | Local only — not for production | No | Free |
| Shopify App Bridge (embedded apps) | Session-token managed | Heavy (Polaris, App Bridge SDK) | No | Free |
| **This Worker** | **No** | **No (serverless edge)** | **Yes** | **Free up to 100k requests/day** |

---

## Quick Start

### 1. Create a Shopify Partner app

Go to [partners.shopify.com](https://partners.shopify.com) → **Apps** → **Create app manually**.

Under **Configuration** → **Admin API scopes**, add the scopes you need:
- `write_products`, `read_products`
- `write_pages`, `read_pages`

Install the app on your store. Copy the **Client ID** and **Client Secret**.

> You will not see an "API credentials" tab with a static token. That's expected. Shopify removed it in 2026. The Worker handles the token exchange for you.

### 2. Deploy the Worker

```bash
git clone https://github.com/brookbharris/shopify-worker-proxy
cd shopify-worker-proxy

# Copy and edit wrangler.toml
cp references/wrangler.toml.example wrangler.toml
# Set SHOPIFY_STORE = "your-store-subdomain"  (not the full myshopify.com URL)

# Copy the Worker source into the project root
cp references/shopify-worker.js .

# Set the three required secrets
wrangler secret put SHOPIFY_CLIENT_ID
wrangler secret put SHOPIFY_CLIENT_SECRET
wrangler secret put WORKER_SECRET       # any strong random string you choose

wrangler deploy
```

### 3. Call it from your app

```js
const cfg = {
  shopifyProxy: "https://your-worker.YOUR-ACCOUNT.workers.dev",
  workerSecret: "the-WORKER_SECRET-you-set-above",
};

async function shopifyFetch(path, body) {
  const resp = await fetch(`${cfg.shopifyProxy}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${cfg.workerSecret}`,
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
  return json;
}

// Create or update a product
const result = await shopifyFetch("shopify/sync/book", {
  title: "My Product",
  price: "14.99",
  status: "DRAFT",
  existingProductId: null,   // null = create; GID string = update
});
// → { productId, handle, url, adminUrl, action: "created" | "updated" }

// Create or update a CMS page
const page = await shopifyFetch("shopify/pages/sync", {
  seriesName: "My Series",
  seriesSlug: "my-series",
  bodyHtml: "<h1>My Series</h1><p>...</p>",
  existingPageId: null,
});
// → { pageId, url, action: "created" | "updated" }
```

A step-by-step walkthrough with verification commands is in [`references/setup-checklist.md`](references/setup-checklist.md).

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Worker status + connected store info |
| POST | `/shopify/sync/book` | Upsert a product (create or update on `existingProductId`) |
| POST | `/shopify/products/create` | Create a product |
| POST | `/shopify/products/update` | Update an existing product |
| POST | `/shopify/products/publish` | Publish or unpublish to the Online Store |
| GET | `/shopify/products/:id` | Get a product's current status |
| POST | `/shopify/pages/sync` | Create or update a Shopify CMS page |

---

## Secrets Reference

| Secret | Required | Description |
|--------|----------|-------------|
| `SHOPIFY_CLIENT_ID` | Yes | Client ID from your Shopify Partner app |
| `SHOPIFY_CLIENT_SECRET` | Yes | Client Secret from your Shopify Partner app |
| `WORKER_SECRET` | Yes | Gate token your browser app sends in `Authorization: Bearer ...` — any strong random string you choose |

All three are set via `wrangler secret put <NAME>`. They are encrypted by Cloudflare and never appear in logs or source code.

---

## Sync State Pattern

After every successful push, store these fields with the item in your database so future syncs update the same Shopify record instead of creating duplicates:

```json
{
  "shopifyProductId": "gid://shopify/Product/1234567890",
  "shopifyHandle": "my-product",
  "shopifyProductUrl": "https://your-store.com/products/my-product",
  "shopifyAdminUrl": "https://admin.shopify.com/store/your-store/products/123",
  "shopifyLastSyncAt": "2026-06-22T21:00:00Z"
}
```

Pass `existingProductId` (or `existingPageId`) on the next sync to update instead of create.

---

## Files

```
shopify-worker-proxy/
├── README.md
├── SKILL.md                              AI agent install guide (Claude, Perplexity, Cursor)
├── LICENSE                               MIT
├── CONTRIBUTING.md
└── references/
    ├── shopify-worker.js                 The Cloudflare Worker source
    ├── wrangler.toml.example             Config template
    └── setup-checklist.md                Step-by-step verified setup guide
```

---

## Common Issues

| Symptom | Fix |
|---------|-----|
| 401 from Worker | `WORKER_SECRET` in client doesn't match the wrangler secret |
| 502 token exchange fails | Wrong Client ID/Secret, or app not installed on the store |
| Product create returns `userErrors` | Scopes not configured before app install — reinstall the app |
| Page creates a duplicate | Store and reuse `pageId` from the first create response |
| CORS error in browser | Add your app's origin to `ALLOWED_ORIGINS` in `wrangler.toml` |

Full troubleshooting tree (every error code Shopify returns and what it actually means) is in the Pro bundle — see below.

---

## Pro version

This repo is the **free, MIT-licensed lite version** — it gives you the Shopify 2026 OAuth pattern, product create/update/publish, and CMS page sync. Everything you need to ship a working Shopify integration from a browser app.

The **Pro bundle** ($24, one-time, on Gumroad — _link coming soon_) adds production extras most people end up needing:

- **Lulu print-on-demand integration** — auto-fire Lulu print jobs when a Shopify order is paid (with HMAC-verified webhook handler)
- **Anthropic API proxy route** — use the same Worker as a secure backend for Claude calls from your frontend
- **Two-variant book products** — Digital Download + Print variants in one product, the way Shopify expects
- **Shopify Liquid template** for series hub pages (`page.book-series.liquid`)
- **Extended troubleshooting decision tree** with every Shopify error code and the exact fix
- **Full `SKILL.md` for AI agents** (Claude Code, Cursor, Perplexity) — paste it in and your agent will run the full setup, including the Partner dashboard walkthrough
- **30 days of email support** for setup questions

If you find this lite version useful and want to support continued maintenance, the Pro bundle is the simplest way.

---

## Contributing

Issues and pull requests welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). Bug reports and questions go in [Issues](https://github.com/brookbharris/shopify-worker-proxy/issues).

This project was built and is maintained by [Brook Harris](https://github.com/brookbharris) with the help of AI coding assistants. I am not a developer by trade — I'm a nonprofit operations professional and small-business owner who built this for my own Shopify store and packaged it so others can use it. If you spot a bug or a better way to do something, please open an issue or PR.

---

## License

[MIT](LICENSE) — use it, fork it, ship it.
