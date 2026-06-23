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
  - `write_files`, `read_files` (if uploading digital files)
  - `read_orders` (if using the orders-paid webhook)
- [ ] Click **Install app** on your store
- [ ] Copy the **Client ID** from the app's credentials page
- [ ] Copy the **Client Secret** from the app's credentials page

> There is no "API credentials" tab with a static token — this is expected. Shopify removed static tokens in 2026. The Worker exchanges Client ID + Secret for a 24h access token automatically.

---

## Phase 2 — Cloudflare Worker

- [ ] Install Wrangler: `npm install -g wrangler`
- [ ] Authenticate: `wrangler login`
- [ ] Create Worker project directory and copy `shopify-worker.js` into it
- [ ] Create `wrangler.toml` with:
  - `SHOPIFY_STORE` = your store subdomain (e.g. `my-store`, not `my-store.myshopify.com`)
  - `ALLOWED_ORIGINS` = your app's domain(s), comma-separated
- [ ] Set required secrets:
  ```bash
  wrangler secret put SHOPIFY_CLIENT_ID
  wrangler secret put SHOPIFY_CLIENT_SECRET
  wrangler secret put WORKER_SECRET
  ```
- [ ] Set optional secrets if needed:
  ```bash
  wrangler secret put ANTHROPIC_API_KEY
  wrangler secret put LULU_CLIENT_KEY
  wrangler secret put LULU_CLIENT_SECRET
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

## Phase 4 — Sync State (if tracking in your app)

- [ ] Add Shopify sync fields to your data model:
  - `shopifyProductId`, `shopifyHandle`, `shopifyProductUrl`
  - `shopifyAdminUrl`, `shopifyPrice`, `shopifyStatus`, `shopifyLastSyncAt`
- [ ] Store `productId` from the first sync response — pass it back as `existingProductId` on future pushes
- [ ] Store `pageId` from the first page sync — pass it back as `existingPageId` on future pushes
- [ ] Implement sync state badge in UI (never / behind / synced)

---

## Phase 5 — Series Hub Pages (optional)

- [ ] Copy `page.book-series.liquid` to your Shopify theme: `templates/page.book-series.liquid`
- [ ] Customize the template for your brand
- [ ] Push a page via the Worker — it will use `template_suffix: "book-series"` automatically
- [ ] Visit `your-store.com/pages/series-slug` to confirm the custom template renders

---

## Phase 6 — Lulu Webhook (optional)

- [ ] Set `LULU_CLIENT_KEY` and `LULU_CLIENT_SECRET` secrets
- [ ] In Shopify Admin → Settings → Notifications → Webhooks:
  - Event: Order payment
  - URL: `https://your-worker.workers.dev/webhooks/shopify/orders-paid`
- [ ] Add `_lulu_pod_package_id`, `_lulu_interior_url`, `_lulu_cover_url` as line item properties on your print variants
- [ ] Place a test order and confirm a Lulu print job is created

---

## Verification Commands

```bash
# Check secrets are set
wrangler secret list

# Health check
curl https://your-worker.workers.dev/health

# Test auth (should return 200 with store info)
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
| Token exchange fails (502) | Wrong client ID/secret or app not installed | Re-check Partners dashboard, reinstall app |
| `write_products` scope error | Scopes not set before install | Add scopes, reinstall app |
| Page creates duplicate | Not passing `existingPageId` | Store and reuse the ID from first create response |
| CORS error in browser | Origin not in `ALLOWED_ORIGINS` | Update wrangler.toml var and redeploy |
| Lulu webhook 401 | `SHOPIFY_CLIENT_SECRET` missing | `wrangler secret put SHOPIFY_CLIENT_SECRET` |
