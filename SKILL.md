---
name: shopify-worker-proxy
description: "Connect any web app or AI agent to the Shopify Admin API without exposing credentials in the browser. Uses a Cloudflare Worker as a secure server-side proxy with auto-refreshing client credentials (Shopify's 2026 OAuth flow). Covers: creating the Shopify Partner app, configuring wrangler secrets, deploying the worker, wiring the browser client, syncing products and CMS pages, and handling Lulu print-on-demand webhooks. Load this skill when the user needs to integrate Shopify into a frontend app, AI tool, or automation that cannot safely hold Admin API credentials, or when they ask how to connect Shopify to a Cloudflare Worker, build a Shopify proxy, push products from a custom UI, or create/update Shopify CMS pages programmatically."
license: MIT
metadata:
  author: shopify-worker-proxy
  version: '1.0'
---

# Shopify Worker Proxy

A pattern for connecting any browser-based app or AI agent to the Shopify Admin API securely — credentials stay server-side in a Cloudflare Worker; the browser never sees a token.

## Architecture Overview

```
Browser / AI Agent UI
       │
       │  POST /shopify/sync/book
       │  Authorization: Bearer <WORKER_SECRET>
       ▼
Cloudflare Worker  (holds all credentials as encrypted secrets)
       │
       │  Auto-fetches 24h Shopify access token via client_credentials grant
       │  X-Shopify-Access-Token: <token>
       ▼
Shopify Admin API  (GraphQL + REST)
```

**Why this matters in 2026:** Shopify deprecated static Admin API tokens for custom apps. New apps must use the OAuth client credentials grant, which returns a 24-hour expiring token. The Worker handles token exchange and caching automatically — the browser UI and any AI agent code remain completely unaware of credentials.

---

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com) with Workers enabled (free tier works)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed: `npm install -g wrangler`
- A Shopify store with Partner Dashboard access at [partners.shopify.com](https://partners.shopify.com)
- Node.js 18+ for local development

---

## Step 1 — Create the Shopify App

> **Important:** As of 2026, Shopify no longer shows a static token in the Admin UI. There is no "API credentials" tab with a copyable token. All new apps use OAuth client credentials.

1. Go to [partners.shopify.com](https://partners.shopify.com) → **Apps** → **Create app**
2. Choose **Create app manually**
3. Name the app (e.g. "My Store Proxy")
4. Under **Configuration** → set **App URL** to your Worker URL (e.g. `https://my-worker.workers.dev`)
5. Under **API access** → configure Admin API scopes for your use case:
   - `write_products`, `read_products` — create/update products
   - `write_pages`, `read_pages` — create/update CMS pages
   - `write_files`, `read_files` — file uploads (optional)
   - `read_orders` — order webhooks (optional)
6. **Install the app** on your store from the Partners dashboard
7. After installation, go to the app's **Client credentials** page — copy:
   - **Client ID** (also called API key)
   - **Client secret**

---

## Step 2 — Deploy the Worker

The full worker source is in `references/shopify-worker.js`. It handles:

- Shopify client credentials token exchange (auto-refresh, cached per isolate)
- Structured product endpoints: `POST /shopify/products/create`, `update`, `publish`
- Book/product upsert: `POST /shopify/sync/book` (creates or updates based on `existingProductId`)
- CMS page upsert: `POST /shopify/pages/sync` (creates or updates series/collection hub pages)
- Anthropic API proxy: `POST /anthropic/v1/messages` (optional — remove if not needed)
- Lulu print-on-demand proxy: `POST /lulu/*` (optional — remove if not needed)
- Shopify webhook handler: `POST /webhooks/shopify/orders-paid` → auto-fires Lulu print jobs

### 2a. Create the Worker project

```bash
mkdir my-shopify-worker && cd my-shopify-worker
wrangler init --no-delegate-c3
```

Copy `references/shopify-worker.js` into the project as your worker entry point.

Update `wrangler.toml`:

```toml
name = "my-shopify-worker"
main = "shopify-worker.js"
compatibility_date = "2024-10-01"

[vars]
SHOPIFY_STORE = "your-store-subdomain"   # just the subdomain, no .myshopify.com
ALLOWED_ORIGINS = "https://your-app.com,https://your-app.pages.dev"
```

### 2b. Set secrets via Wrangler

Run each command and paste the value when prompted — values are never echoed or logged:

```bash
wrangler secret put SHOPIFY_CLIENT_ID       # Client ID from Partners dashboard
wrangler secret put SHOPIFY_CLIENT_SECRET   # Client Secret from Partners dashboard
wrangler secret put WORKER_SECRET           # A strong random string you choose (32+ chars)
```

Optional secrets (only needed if using those features):
```bash
wrangler secret put ANTHROPIC_API_KEY       # Anthropic sk-ant-... key
wrangler secret put LULU_CLIENT_KEY         # Lulu API client key
wrangler secret put LULU_CLIENT_SECRET      # Lulu API client secret
```

### 2c. Deploy

```bash
wrangler deploy
```

Your worker is now live at `https://my-shopify-worker.YOUR-ACCOUNT.workers.dev`.

---

## Step 3 — Configure the Browser Client

In your frontend app, set a config object (never hardcode the Worker URL in multiple places):

```js
window.MY_APP_CONFIG = {
  shopifyProxy: "https://my-shopify-worker.YOUR-ACCOUNT.workers.dev",
  workerSecret: "the-same-WORKER_SECRET-you-set-above",
};
```

> **Security note:** `WORKER_SECRET` is a gate token for your own app — it proves the request came from your UI, not a random internet user who discovered your Worker URL. It is NOT a Shopify credential. It is safe to embed in your frontend bundle. The Shopify credentials (`SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`) never leave the Worker.

### Making calls from the browser

```js
async function shopifyFetch(path, body) {
  const cfg = window.MY_APP_CONFIG;
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
  title: "My Training Guide",
  body_html: "<p>A comprehensive guide.</p>",
  price: "14.99",
  status: "DRAFT",
  kind: "book",                           // "book" = EPUB + print variants; "document" = PDF only
  existingProductId: null,                // null = create; GID string = update
  hasPrint: false,                        // true = add a print variant linked to Lulu
});
// result.productId, result.handle, result.url, result.adminUrl

// Create or update a CMS series hub page at /pages/my-series
const pageResult = await shopifyFetch("shopify/pages/sync", {
  seriesName: "My Training Series",
  seriesSlug: "my-series",               // becomes /pages/my-series
  bodyHtml: "<h1>My Series</h1><p>...</p>",
  existingPageId: null,                  // null = create; ID string = update
});
// pageResult.pageId, pageResult.url, pageResult.action ("created" | "updated")
```

---

## Step 4 — Sync State Pattern

Track whether your local content matches what's live on Shopify. Store these fields alongside each item in your data model (Firebase, localStorage, or any DB):

```json
{
  "shopifyProductId": "gid://shopify/Product/1234567890",
  "shopifyHandle": "my-training-guide",
  "shopifyProductUrl": "https://your-store.com/products/my-training-guide",
  "shopifyAdminUrl": "https://admin.shopify.com/store/your-store/products/123",
  "shopifyPrice": "14.99",
  "shopifyStatus": "DRAFT",
  "shopifyLastSyncAt": "2026-06-22T21:00:00Z"
}
```

Derive sync state in the UI:

```js
function getSyncState(item) {
  if (!item.shopifyProductId) return "never";           // never pushed
  const syncedAt = new Date(item.shopifyLastSyncAt);
  const editedAt = new Date(item.updatedAt);
  if (editedAt > syncedAt) return "behind";             // local changes not pushed
  return "synced";                                      // in sync
}
```

Display badges:
- **Not yet pushed** — neutral, prompt to publish
- **⚠ Updates pending** — yellow, local edits exist since last push
- **✓ In sync** — green, Shopify matches local content

---

## Step 5 — Series Hub Pages

For content-heavy stores, a CMS Page at `/pages/series-name` is better than a Collection page because you control the full HTML layout. The Worker's `POST /shopify/pages/sync` endpoint:

1. Checks for `existingPageId` — if present, does a PUT update
2. Falls back to checking by `handle` — finds and updates an existing page
3. Falls back to POST create — creates a new page with `template_suffix: "book-series"`

The `template_suffix` lets you create a custom Liquid template in your Shopify theme (`templates/page.book-series.liquid`) for a custom layout. Without the template file, Shopify falls back to the default page template gracefully.

See `references/page.book-series.liquid` for a starter Liquid template.

---

## Step 6 — Lulu Print-on-Demand Webhook (Optional)

If you sell physical books via Lulu print-on-demand, the Worker can automatically fire Lulu print jobs when a Shopify order is paid.

### Setup
1. Set `LULU_CLIENT_KEY` and `LULU_CLIENT_SECRET` secrets (from [lulu.com developer portal](https://developers.lulu.com))
2. Register a webhook in Shopify Admin → **Settings** → **Notifications** → **Webhooks**:
   - Event: **Order payment**
   - URL: `https://your-worker.workers.dev/webhooks/shopify/orders-paid`

### How it works
When a paid order contains a line item with these properties on the print variant:
- `_lulu_pod_package_id` — Lulu 27-character package SKU
- `_lulu_interior_url` — public URL to interior PDF
- `_lulu_cover_url` — public URL to cover PDF

The Worker verifies the Shopify HMAC signature, builds a Lulu print job, and fires it automatically. The Shopify `SHOPIFY_CLIENT_SECRET` doubles as the webhook signing key.

---

## Endpoint Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Worker health check + config info |
| POST | `/shopify/products/create` | Create a new product |
| POST | `/shopify/products/update` | Update an existing product (requires `productId`) |
| POST | `/shopify/products/publish` | Publish or unpublish a product |
| POST | `/shopify/sync/book` | Upsert — creates or updates based on `existingProductId` |
| GET | `/shopify/products/:id` | Fetch product status |
| POST | `/shopify/pages/sync` | Create or update a CMS page |
| POST | `/anthropic/v1/messages` | Anthropic API proxy (optional) |
| POST | `/lulu/print-jobs` | Lulu print job proxy (optional) |
| POST | `/webhooks/shopify/orders-paid` | Lulu auto-fulfillment webhook |

---

## Troubleshooting

**Token exchange fails (HTTP 401/403)**
- Confirm `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` are set: `wrangler secret list`
- Confirm the app is installed on the store in Partners dashboard
- Confirm `SHOPIFY_STORE` var matches the store subdomain exactly (no `.myshopify.com`)

**Worker returns 401 Unauthorized**
- The `Authorization: Bearer` header in your browser client must match `WORKER_SECRET` exactly

**Product create returns userErrors**
- Check that the API scopes (`write_products`) were configured before installing the app
- Re-installing the app after adding scopes regenerates the grant

**Page creates a duplicate instead of updating**
- Pass `existingPageId` from the first create response back on future pushes — store it in your data model

**CORS errors in browser**
- Add your app's origin to `ALLOWED_ORIGINS` in `wrangler.toml` and redeploy

---

## References

- `references/shopify-worker.js` — Full Cloudflare Worker source, ready to deploy
- `references/page.book-series.liquid` — Starter Liquid template for series hub pages
- `references/setup-checklist.md` — Step-by-step install checklist
