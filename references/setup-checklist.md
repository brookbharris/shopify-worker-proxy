# Shopify Worker Proxy — Setup Checklist

Work through these in order. Each step is a prerequisite for the next.

---

## Phase 1 — Shopify App

- [ ] Log in to [partners.shopify.com](https://partners.shopify.com)
- [ ] Navigate to **Apps** → **Create app** → **Create app manually**
- [ ] Name the app and set the App URL to your Worker URL (you can update this after deploy)
- [ ] Under **Configuration** → **Admin API scopes**, select the scopes you need:
  - `write_products`, `read_products`
  - `write_pages`, `read_pages`
- [ ] Click **Install app** on your store
- [ ] Copy the **Client ID** from the app's credentials page
- [ ] Copy the **Client Secret** from the app's credentials page

> There is no "API credentials" tab with a static token — this is expected. Shopify removed static tokens in 2026. The Worker exchanges Client ID + Secret for a 24h access token automatically.

---

## Phase 2 — Cloudflare Worker

- [ ] Install Wrangler: `npm install -g wrangler`
- [ ] Authenticate: `wrangler login`
- [ ] Create a Worker project directory and copy `shopify-worker.js` into it
- [ ] Copy `wrangler.toml.example` to `wrangler.toml` and update:
  - `SHOPIFY_STORE` = your store subdomain (e.g. `my-store`, not `my-store.myshopify.com`)
  - `ALLOWED_ORIGINS` = your app's domain(s), comma-separated
- [ ] Set the three required secrets:
  ```bash
  wrangler secret put SHOPIFY_CLIENT_ID
  wrangler secret put SHOPIFY_CLIENT_SECRET
  wrangler secret put WORKER_SECRET
  ```
- [ ] Deploy: `wrangler deploy`
- [ ] Verify: `curl https://your-worker.workers.dev/health` should return `{"ok":true,...}`

---

## Phase 3 — Browser Client

- [ ] Add your Worker URL and `WORKER_SECRET` to your app's config object
- [ ] Test a product sync: `POST /shopify/sync/book` with a test payload
- [ ] Confirm the product appears in Shopify Admin → Products (in Draft status)
- [ ] Test a page sync: `POST /shopify/pages/sync` with a test payload
- [ ] Confirm the page appears in Shopify Admin → Online Store → Pages

---

## Phase 4 — Sync State (recommended)

- [ ] Add Shopify sync fields to your data model:
  - `shopifyProductId`, `shopifyHandle`, `shopifyProductUrl`
  - `shopifyAdminUrl`, `shopifyLastSyncAt`
- [ ] Store `productId` from the first sync response — pass it back as `existingProductId` on future pushes (so updates don't create duplicates)
- [ ] Store `pageId` from the first page sync — pass it back as `existingPageId` on future pushes

---

## Verification Commands

```bash
# Check secrets are set
wrangler secret list

# Health check
curl https://your-worker.workers.dev/health

# Create a test product (should return 200 with product details)
curl -X POST https://your-worker.workers.dev/shopify/products/create \
  -H "Authorization: Bearer YOUR_WORKER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test Product","status":"DRAFT","price":"9.99"}'
```

---

## Common Issues

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Worker returns 401 | `WORKER_SECRET` mismatch | Verify client config matches wrangler secret |
| Token exchange fails (502) | Wrong Client ID/Secret or app not installed | Re-check Partners dashboard, reinstall app |
| `write_products` scope error | Scopes not set before install | Add scopes, reinstall the app on your store |
| Page creates duplicate | Not passing `existingPageId` | Store and reuse the ID from the first create response |
| CORS error in browser | Origin not in `ALLOWED_ORIGINS` | Update wrangler.toml var and redeploy |
