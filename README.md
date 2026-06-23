# shopify-worker-proxy

A production-ready Cloudflare Worker that proxies Shopify Admin API calls from browser apps and AI agents — without exposing credentials in the browser.

Works with **Shopify's 2026 client credentials OAuth flow**. No static token required (Shopify removed that).

---

## The Problem

Shopify deprecated static Admin API tokens for custom apps. If you're building a browser-based tool, an AI agent UI, or any frontend that needs to write to Shopify, you now need to:

1. Exchange a Client ID + Secret for a 24-hour access token
2. Keep those credentials off the browser
3. Handle token refresh transparently

This Worker does all three.

---

## Architecture

```
Browser / AI Agent UI
       │
       │  POST /shopify/sync/book
       │  Authorization: Bearer <WORKER_SECRET>
       ▼
Cloudflare Worker           ← credentials live here only
       │
       │  Auto-fetches 24h Shopify token via client_credentials grant
       ▼
Shopify Admin API
```

Your app never sees `SHOPIFY_CLIENT_ID` or `SHOPIFY_CLIENT_SECRET`. The Worker fetches a fresh token, makes the API call, and returns structured JSON.

---

## Quick Start

### 1. Create a Shopify Partner app

Go to [partners.shopify.com](https://partners.shopify.com) → Apps → Create app manually.

Under **Admin API scopes**, add:
- `write_products`, `read_products`
- `write_pages`, `read_pages`

Install the app on your store. Copy the **Client ID** and **Client Secret**.

> There is no "API credentials" tab with a static token — that's expected. Shopify removed it. The Worker handles the token exchange automatically.

### 2. Deploy the Worker

```bash
git clone https://github.com/YOUR_USERNAME/shopify-worker-proxy
cd shopify-worker-proxy

# Edit wrangler.toml — set SHOPIFY_STORE to your store subdomain
# (just "my-store", not "my-store.myshopify.com")

wrangler secret put SHOPIFY_CLIENT_ID
wrangler secret put SHOPIFY_CLIENT_SECRET
wrangler secret put WORKER_SECRET       # any strong random string you choose

wrangler deploy
```

### 3. Call it from your browser app

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

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Worker health check |
| POST | `/shopify/sync/book` | Upsert product (create or update) |
| POST | `/shopify/products/create` | Create a product |
| POST | `/shopify/products/update` | Update an existing product |
| POST | `/shopify/products/publish` | Publish or unpublish |
| GET | `/shopify/products/:id` | Get product status |
| POST | `/shopify/pages/sync` | Create or update a CMS page |
| POST | `/anthropic/v1/messages` | Anthropic API proxy (optional) |
| POST | `/lulu/print-jobs` | Lulu POD proxy (optional) |
| POST | `/webhooks/shopify/orders-paid` | Auto-fire Lulu print jobs on paid orders |

---

## Secrets Reference

| Secret | Required | Description |
|--------|----------|-------------|
| `SHOPIFY_CLIENT_ID` | Yes | Client ID from Shopify Partners app |
| `SHOPIFY_CLIENT_SECRET` | Yes | Client Secret from Shopify Partners app |
| `WORKER_SECRET` | Yes | Gate token — any strong random string |
| `ANTHROPIC_API_KEY` | Optional | Only if using the Anthropic proxy route |
| `LULU_CLIENT_KEY` | Optional | Only if using Lulu POD integration |
| `LULU_CLIENT_SECRET` | Optional | Only if using Lulu POD integration |

---

## Sync State Pattern

Store these fields with each item in your data layer after a successful push:

```json
{
  "shopifyProductId": "gid://shopify/Product/1234567890",
  "shopifyHandle": "my-product",
  "shopifyProductUrl": "https://your-store.com/products/my-product",
  "shopifyAdminUrl": "https://admin.shopify.com/store/your-store/products/123",
  "shopifyLastSyncAt": "2026-06-22T21:00:00Z"
}
```

Pass `existingProductId` on future syncs to update instead of create.

---

## Files

```
shopify-worker-proxy/
├── SKILL.md                              AI agent skill file (Perplexity Computer, Claude, etc.)
├── references/
│   ├── shopify-worker.js                 Cloudflare Worker source (~1,000 lines)
│   ├── wrangler.toml.example             Config template
│   ├── page.book-series.liquid           Shopify Liquid template for CMS hub pages
│   └── setup-checklist.md               Step-by-step verified setup guide
```

---

## Common Issues

| Symptom | Fix |
|---------|-----|
| 401 from Worker | `WORKER_SECRET` in client doesn't match wrangler secret |
| 502 token exchange fails | Wrong Client ID/Secret, or app not installed on store |
| Product create returns userErrors | Scopes not configured before app install — reinstall app |
| Page creates duplicate | Store and reuse `pageId` from first create response |
| CORS error | Add your origin to `ALLOWED_ORIGINS` in `wrangler.toml` |

---

## License

MIT

---

## Full Setup Guide + Packaged Download

The `references/setup-checklist.md` walks through every step including the Partner dashboard flow that most tutorials skip.

A packaged version with additional documentation is available on [Gumroad](#) — includes everything in this repo plus a verified troubleshooting guide and the AI agent SKILL.md file pre-formatted for direct import.
