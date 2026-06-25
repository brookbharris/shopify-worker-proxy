/**
 * shopify-worker-proxy (lite)
 * Cloudflare Worker · deploy with `wrangler deploy`
 *
 * A secure server-side proxy for the Shopify Admin API. Lets browser apps and
 * AI agents push products and CMS pages to Shopify without exposing credentials
 * in the browser.
 *
 * Shopify authentication: client credentials grant (Dev Dashboard apps, Jan 2026+)
 *   The Worker automatically exchanges SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
 *   for a 24-hour access token. The token is cached and refreshed automatically
 *   — you never paste or see a raw Shopify Admin token.
 *
 * Endpoints:
 *   GET  /health                       Worker status
 *   POST /shopify/products/create      Create a product (GraphQL productCreate)
 *   POST /shopify/products/update      Update a product (GraphQL productUpdate)
 *   POST /shopify/products/publish     Publish or unpublish to the Online Store
 *   POST /shopify/sync/book            Upsert a product (create or update on existingProductId)
 *   POST /shopify/pages/sync           Create or update a Shopify CMS page
 *   GET  /shopify/products/:productId  Fetch a single product's status
 *
 * Secrets (set via `wrangler secret put <NAME>`):
 *   SHOPIFY_CLIENT_ID      Client ID from your Shopify Partner app
 *   SHOPIFY_CLIENT_SECRET  Client Secret from your Shopify Partner app
 *   WORKER_SECRET          A strong random string you choose — gates the Worker
 *
 * Env vars (set in wrangler.toml [vars]):
 *   SHOPIFY_STORE    Store subdomain without .myshopify.com  (e.g. "my-store")
 *   ALLOWED_ORIGINS  Comma-separated allowed browser origins
 *
 * Security model:
 *   1. Bearer token (WORKER_SECRET) — blocks anyone who finds the Worker URL
 *   2. CORS origin allowlist — blocks unauthorized browser origins
 *   3. Shopify credentials are encrypted Cloudflare Secrets — never in code or logs
 *   4. Shopify access token is fetched server-side and cached — never sent to the browser
 *
 * License: MIT
 */

const API_VERSION = "2024-10";

// Module-level token cache (per Worker isolate).
// Shopify access tokens expire after 24h; we refresh 5 minutes early.
let shopifyTokenCache = { token: null, expiresAt: 0 };

// Retry helper for cold-start resilience: a freshly-spun isolate's first
// upstream call can fail transiently. Retry up to `retries` times.
async function fetchWithRetry(url, opts, retries = 2, delayMs = 500) {
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, opts);
      if (resp.ok || i === retries) return resp;
    } catch (e) {
      if (i === retries) throw e;
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
}

export default {
  async fetch(request, env) {
    const origin  = request.headers.get("Origin") || "";
    const store   = (env.SHOPIFY_STORE  || "your-store").trim();
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

    let selfOrigin = "";
    try { selfOrigin = new URL(request.url).origin; } catch { /* noop */ }

    const originOk =
      !origin ||
      origin === selfOrigin ||
      allowed.includes(origin) ||
      /^https?:\/\/localhost(:\d+)?(\/|$)/.test(origin);

    const cors = {
      "Access-Control-Allow-Origin":  originOk ? (origin || selfOrigin) : (allowed[0] || ""),
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age":       "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // ── Bearer token auth ─────────────────────────────────────────────────
    const expectedSecret = (env.WORKER_SECRET || "").trim();
    if (expectedSecret) {
      const authHeader = (request.headers.get("Authorization") || "").trim();
      const provided   = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
      if (provided !== expectedSecret) {
        return respond({ error: "Unauthorized" }, 401, cors);
      }
    }

    if (!originOk && allowed.length) {
      return respond({ error: "Origin not permitted: " + origin }, 403, cors);
    }

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "" || url.pathname === "/health") {
      return respond({
        ok: true, store, apiVersion: API_VERSION,
        worker: "shopify-worker-proxy",
        shopifyAuth: "client-credentials (auto-refresh, no token visible to user)",
        endpoints: [
          "POST /shopify/products/create",
          "POST /shopify/products/update",
          "POST /shopify/products/publish",
          "POST /shopify/sync/book",
          "POST /shopify/pages/sync",
          "GET  /shopify/products/:id",
        ],
        auth: expectedSecret ? "bearer-required" : "WARNING: open — set WORKER_SECRET"
      }, 200, cors);
    }

    return handleShopify(request, env, url, cors, store);
  },
};

// ── Shopify token exchange (client credentials) ───────────────────────────────
// Shopify Dev Dashboard apps (Jan 2026+) no longer show a static token in the UI.
// We exchange SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET for a 24h token,
// cache it, and refresh automatically. The user never sees a Shopify token.
async function getShopifyToken(env, store) {
  const now = Date.now();
  if (shopifyTokenCache.token && now < shopifyTokenCache.expiresAt) {
    return shopifyTokenCache.token;
  }

  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
    throw new Error("SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET secrets must be set.");
  }

  const tokenUrl = `https://${store}.myshopify.com/admin/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     env.SHOPIFY_CLIENT_ID,
    client_secret: env.SHOPIFY_CLIENT_SECRET,
  });

  const resp = await fetchWithRetry(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Shopify token exchange failed (HTTP ${resp.status}): ${detail}`);
  }

  const data = await resp.json();
  if (!data.access_token) {
    throw new Error(`Shopify token exchange returned no access_token: ${JSON.stringify(data)}`);
  }

  const ttl = (Number(data.expires_in) || 86399) * 1000;
  shopifyTokenCache = {
    token:     data.access_token,
    expiresAt: now + ttl - (5 * 60 * 1000),
  };

  return shopifyTokenCache.token;
}

// ── Router ────────────────────────────────────────────────────────────────────
async function handleShopify(request, env, url, cors, store) {
  const path = url.pathname.replace(/^\/(shopify\/)?/, "");

  if (request.method === "POST" && path === "products/create") {
    return shopifyCreate(request, env, cors, store);
  }
  if (request.method === "POST" && path === "products/update") {
    return shopifyUpdate(request, env, cors, store);
  }
  if (request.method === "POST" && path === "products/publish") {
    return shopifyPublish(request, env, cors, store);
  }
  if (request.method === "POST" && path === "pages/sync") {
    return shopifySyncPage(request, env, cors, store);
  }
  if (request.method === "POST" && path === "sync/book") {
    return shopifySyncBook(request, env, cors, store);
  }
  const single = path.match(/^products\/([^/.?]+)$/);
  if (request.method === "GET" && single) {
    return shopifyGetProduct(single[1], env, cors, store);
  }

  return respond({ error: "Path not permitted: /" + path }, 404, cors);
}

// ── Shopify Admin GraphQL helper ──────────────────────────────────────────────
async function shopifyGraphQL(env, store, query, variables) {
  let token;
  try { token = await getShopifyToken(env, store); }
  catch (e) {
    return { ok: false, status: 502, json: { errors: [{ message: String(e.message || e) }] } };
  }

  const resp = await fetchWithRetry(
    `https://${store}.myshopify.com/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { errors: text }; }
  return { ok: resp.ok, status: resp.status, json };
}

const numericId = (gid) => (gid ? String(gid).split("/").pop() : "");

function storefrontUrl(store, handle, onlineStoreUrl) {
  return onlineStoreUrl || (handle ? `https://${store}.myshopify.com/products/${handle}` : "");
}
const adminUrl = (store, gid) => `https://admin.shopify.com/store/${store}/products/${numericId(gid)}`;

function productInput(b) {
  const input = {};
  if (b.title        != null) input.title = b.title;
  if (b.body_html    != null) input.descriptionHtml = b.body_html;
  if (b.vendor       != null) input.vendor = b.vendor;
  if (b.product_type != null) input.productType = b.product_type;
  if (b.handle       != null) input.handle = b.handle;
  if (b.status       != null) input.status = String(b.status).toUpperCase();
  if (b.tags != null) input.tags = Array.isArray(b.tags) ? b.tags : String(b.tags).split(",").map(s => s.trim()).filter(Boolean);
  if (Array.isArray(b.metafields) && b.metafields.length) {
    input.metafields = b.metafields.map(m => ({
      namespace: m.namespace || "custom",
      key: m.key,
      type: m.type || "single_line_text_field",
      value: typeof m.value === "string" ? m.value : JSON.stringify(m.value),
    }));
  }
  if (b.price != null || b.sku != null) {
    const variant = {};
    if (b.price != null) variant.price = String(b.price);
    if (b.sku   != null) variant.sku   = String(b.sku);
    input.variants = [variant];
  }
  return input;
}

const mediaInput = (images) =>
  (Array.isArray(images) ? images : [])
    .map(img => (typeof img === "string" ? img : img && (img.src || img.url)))
    .filter(Boolean)
    .map(src => ({ originalSource: src, mediaContentType: "IMAGE" }));

const PRODUCT_FIELDS = `
  id title handle status onlineStoreUrl
  variants(first: 1) { edges { node { id } } }`;

function shapeProduct(store, p) {
  const variantId = p && p.variants && p.variants.edges && p.variants.edges[0]
    ? p.variants.edges[0].node.id : "";
  return {
    productId: p.id,
    variantId,
    handle: p.handle,
    url: storefrontUrl(store, p.handle, p.onlineStoreUrl),
    adminUrl: adminUrl(store, p.id),
  };
}

// ── Product create ────────────────────────────────────────────────────────────
async function shopifyCreate(request, env, cors, store) {
  let body;
  try { body = await request.json(); } catch { return respond({ error: "Invalid JSON body." }, 400, cors); }

  const query = `
    mutation productCreate($input: ProductInput!, $media: [CreateMediaInput!]) {
      productCreate(input: $input, media: $media) {
        product { ${PRODUCT_FIELDS} }
        userErrors { field message }
      }
    }`;
  const { ok, status, json } = await shopifyGraphQL(env, store, query, { input: productInput(body), media: mediaInput(body.images) });
  const result = json && json.data && json.data.productCreate;
  if (!ok || (json && json.errors) || (result && result.userErrors && result.userErrors.length)) {
    return respond({ error: "productCreate failed", details: (json && json.errors) || (result && result.userErrors) }, status === 200 ? 422 : status, cors);
  }
  return respond(shapeProduct(store, result.product), 200, cors);
}

// ── Product update ────────────────────────────────────────────────────────────
async function shopifyUpdate(request, env, cors, store) {
  let body;
  try { body = await request.json(); } catch { return respond({ error: "Invalid JSON body." }, 400, cors); }
  if (!body.productId) return respond({ error: "productId is required." }, 400, cors);

  const input = productInput(body);
  input.id = body.productId;

  const query = `
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { ${PRODUCT_FIELDS} }
        userErrors { field message }
      }
    }`;
  const { ok, status, json } = await shopifyGraphQL(env, store, query, { input });
  const result = json && json.data && json.data.productUpdate;
  if (!ok || (json && json.errors) || (result && result.userErrors && result.userErrors.length)) {
    return respond({ error: "productUpdate failed", details: (json && json.errors) || (result && result.userErrors) }, status === 200 ? 422 : status, cors);
  }
  return respond(shapeProduct(store, result.product), 200, cors);
}

// ── Publish / unpublish to Online Store ───────────────────────────────────────
let onlineStorePubCache = { id: null };
async function onlineStorePublicationId(env, store) {
  if (onlineStorePubCache.id) return onlineStorePubCache.id;
  const query = `{ publications(first: 10) { edges { node { id name } } } }`;
  const { json } = await shopifyGraphQL(env, store, query, {});
  const edges = (json && json.data && json.data.publications && json.data.publications.edges) || [];
  const online = edges.find(e => e.node.name === "Online Store") || edges[0];
  onlineStorePubCache.id = online ? online.node.id : null;
  return onlineStorePubCache.id;
}

async function shopifyPublish(request, env, cors, store) {
  let body;
  try { body = await request.json(); } catch { return respond({ error: "Invalid JSON body." }, 400, cors); }
  if (!body.productId) return respond({ error: "productId is required." }, 400, cors);

  const publish = body.publish !== false;
  const pubId = await onlineStorePublicationId(env, store);
  if (!pubId) return respond({ error: "No Online Store publication found." }, 502, cors);

  const query = publish
    ? `mutation pub($id: ID!, $input: [PublicationInput!]!) {
         publishablePublish(id: $id, input: $input) {
           publishable { ... on Product { ${PRODUCT_FIELDS} } }
           userErrors { field message }
         }
       }`
    : `mutation unpub($id: ID!, $input: [PublicationInput!]!) {
         publishableUnpublish(id: $id, input: $input) {
           publishable { ... on Product { ${PRODUCT_FIELDS} } }
           userErrors { field message }
         }
       }`;

  const { ok, status, json } = await shopifyGraphQL(env, store, query, { id: body.productId, input: [{ publicationId: pubId }] });
  const result = json && json.data && (json.data.publishablePublish || json.data.publishableUnpublish);
  if (!ok || (json && json.errors) || (result && result.userErrors && result.userErrors.length)) {
    return respond({ error: "publish failed", details: (json && json.errors) || (result && result.userErrors) }, status === 200 ? 422 : status, cors);
  }
  const p = result.publishable || {};
  return respond({ status: publish ? "published" : "unpublished", url: storefrontUrl(store, p.handle, p.onlineStoreUrl) }, 200, cors);
}

// ── Upsert a single product (create or update on existingProductId) ───────────
async function shopifySyncBook(request, env, cors, store) {
  let body;
  try { body = await request.json(); } catch { return respond({ error: "Invalid JSON body." }, 400, cors); }

  const existing = body.existingProductId;
  const innerBody = { ...body };
  if (existing) innerBody.productId = existing;

  const innerReq = new Request(request.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(innerBody),
  });

  const resp = existing
    ? await shopifyUpdate(innerReq, env, cors, store)
    : await shopifyCreate(innerReq, env, cors, store);

  if (resp.status !== 200) return resp;
  const data = await resp.json();
  return respond({ ...data, action: existing ? "updated" : "created" }, 200, cors);
}

// ── Shopify CMS Pages sync (idempotent create-or-update by handle) ────────────
async function shopifySyncPage(request, env, cors, store) {
  let body;
  try { body = await request.json(); } catch { return respond({ error: "Invalid JSON body." }, 400, cors); }

  const { seriesName, seriesSlug, bodyHtml, existingPageId } = body;
  if (!seriesName || !bodyHtml) return respond({ error: "seriesName and bodyHtml are required." }, 400, cors);

  const handle = seriesSlug || seriesName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/, "");

  let token;
  try { token = await getShopifyToken(env, store); } catch (e) { return respond({ error: String(e.message || e) }, 502, cors); }

  const shopifyBase = `https://${store}.myshopify.com/admin/api/${API_VERSION}`;

  // 1. If caller passed an existingPageId, try updating that first
  if (existingPageId) {
    const updateResp = await fetchWithRetry(`${shopifyBase}/pages/${existingPageId}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ page: { id: existingPageId, body_html: bodyHtml, title: seriesName } }),
    });
    if (updateResp.ok) {
      const data = await updateResp.json();
      const p = data.page || {};
      return respond({
        action: "updated",
        pageId: String(p.id || existingPageId),
        url: `https://${store}.myshopify.com/pages/${p.handle || handle}`,
        adminUrl: `https://admin.shopify.com/store/${store}/pages/${p.id || existingPageId}`,
      }, 200, cors);
    }
    // Fall through to handle lookup / create if page was deleted
  }

  // 2. Check if a page with this handle already exists (avoids duplicates)
  const listResp = await fetchWithRetry(`${shopifyBase}/pages.json?handle=${encodeURIComponent(handle)}&fields=id,handle,title`, {
    headers: { "X-Shopify-Access-Token": token },
  });
  if (listResp.ok) {
    const listData = await listResp.json();
    const existing = listData.pages && listData.pages[0];
    if (existing) {
      const upResp = await fetchWithRetry(`${shopifyBase}/pages/${existing.id}.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({ page: { id: existing.id, body_html: bodyHtml, title: seriesName } }),
      });
      if (upResp.ok) {
        const data = await upResp.json();
        const p = data.page || {};
        return respond({
          action: "updated",
          pageId: String(p.id),
          url: `https://${store}.myshopify.com/pages/${p.handle || handle}`,
          adminUrl: `https://admin.shopify.com/store/${store}/pages/${p.id}`,
        }, 200, cors);
      }
    }
  }

  // 3. Create new page
  const createResp = await fetchWithRetry(`${shopifyBase}/pages.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({
      page: {
        title: seriesName,
        handle,
        body_html: bodyHtml,
        published: true,
      },
    }),
  });
  if (!createResp.ok) {
    const detail = await createResp.text();
    return respond({ error: `Page create failed (HTTP ${createResp.status})`, detail }, createResp.status, cors);
  }
  const createData = await createResp.json();
  const p = createData.page || {};
  return respond({
    action: "created",
    pageId: String(p.id),
    url: `https://${store}.myshopify.com/pages/${p.handle || handle}`,
    adminUrl: `https://admin.shopify.com/store/${store}/pages/${p.id}`,
  }, 200, cors);
}

// ── Get a single product's status ─────────────────────────────────────────────
async function shopifyGetProduct(productId, env, cors, store) {
  const gid = /^gid:\/\//.test(productId) ? productId : `gid://shopify/Product/${productId}`;
  const query = `query getProduct($id: ID!) { product(id: $id) { id title status handle onlineStoreUrl } }`;
  const { ok, status, json } = await shopifyGraphQL(env, store, query, { id: gid });
  const p = json && json.data && json.data.product;
  if (!ok || (json && json.errors)) {
    return respond({ error: "product fetch failed", details: json && json.errors }, status === 200 ? 422 : status, cors);
  }
  if (!p) return respond({ error: "Product not found." }, 404, cors);
  return respond({ id: p.id, title: p.title, status: p.status, handle: p.handle, url: storefrontUrl(store, p.handle, p.onlineStoreUrl) }, 200, cors);
}

function respond(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
