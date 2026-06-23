/**
 * Cascadian Paws — Multi-service API Proxy
 * Cloudflare Worker · deploy with `wrangler deploy`
 *
 * Proxies three upstreams behind a single Bearer-secret gate:
 *   /shopify/*    → Shopify Admin API (structured product endpoints + allowlisted REST reads)
 *   /anthropic/*  → Anthropic Messages API
 *   /lulu/*       → Lulu Print API (with OAuth2 client_credentials token exchange)
 *
 * Shopify authentication: client credentials grant (Dev Dashboard apps, Jan 2026+)
 *   The Worker automatically exchanges SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET for a
 *   24-hour access token via POST /admin/oauth/access_token. The token is cached in the
 *   Worker isolate and refreshed automatically — you NEVER paste or see a raw Shopify token.
 *
 * Structured Shopify endpoints (the browser sends book data; the Worker assembles the
 * Admin GraphQL call, so the storefront never constructs a raw Shopify API request):
 *   POST /shopify/products/create     productCreate
 *   POST /shopify/products/update     productUpdate
 *   POST /shopify/products/publish    publishablePublish / publishableUnpublish
 *   POST /shopify/sync/book           upsert (create or update on existingProductId)
 *   GET  /shopify/products/:productId fetch a single product's status
 *
 * Secrets (set via `wrangler secret put <NAME>` — you are prompted; value is never echoed):
 *   SHOPIFY_CLIENT_ID     Client ID from Dev Dashboard → your app → Settings
 *   SHOPIFY_CLIENT_SECRET Client Secret from Dev Dashboard → your app → Settings
 *   WORKER_SECRET         A strong random string you choose — must match workerSecret in CPAWS_CONFIG
 *   ANTHROPIC_API_KEY     Anthropic API key (sk-ant-...)
 *   LULU_CLIENT_KEY       Lulu API client key (optional)
 *   LULU_CLIENT_SECRET    Lulu API client secret (optional)
 *
 * Env vars (plain text — set in wrangler.toml [vars] or Cloudflare dashboard):
 *   SHOPIFY_STORE    Store subdomain without .myshopify.com  e.g. "your-store"
 *   ALLOWED_ORIGINS  Comma-separated allowed origins         e.g. "https://brookbharris.github.io"
 *
 * Security model:
 *   1. Bearer token (WORKER_SECRET) — blocks anyone who discovers the URL from using it
 *   2. CORS origin check — blocks unauthorized browser origins
 *   3. Endpoint allowlist — limits which upstream API paths can be called
 *   4. Upstream credentials are encrypted Cloudflare Secrets — never in code or logs
 *   5. Shopify token is fetched programmatically and cached — never pasted or seen by the user
 */

const API_VERSION = "2024-10";

const ALLOWED_PATHS = [
  /^products(\/\d+)?(\/\w+)?\.json/,
  /^orders\.json/,
  /^orders\/\d+\.json/,
  /^inventory_levels\.json/,
  /^inventory_items\/\d+\.json/,
  /^smart_collections(\/\d+)?\.json/,
  /^custom_collections(\/\d+)?\.json/,
  /^collects(\/\d+)?\.json/,
  /^collections\/\d+\.json/,
  /^shop\.json/,
  /^product_listings\.json/,
];

const ANTHROPIC_ALLOWED_PATHS = [
  /^v1\/messages\/?$/,
  /^v1\/models\/?$/,
];

const LULU_ALLOWED = [
  { method: "POST", re: /^print-jobs\/?$/ },
  { method: "GET",  re: /^print-jobs\/\d+\/?$/ },
  { method: "POST", re: /^print-jobs\/cost-calculations\/?$/ },
  { method: "POST", re: /^print-jobs\/file-validation-jobs\/?$/ },
];

const ANTHROPIC_BASE = "https://api.anthropic.com";
const LULU_BASE       = "https://api.lulu.com";
const LULU_TOKEN_URL  = "https://api.lulu.com/auth/realms/glasstree/protocol/openid-connect/token";

// Module-level token caches (per Worker isolate).
// Shopify tokens expire after 24h (86399s); we refresh 5 minutes early.
// Lulu tokens expire after ~300s; we refresh 30s early.
let shopifyTokenCache = { token: null, expiresAt: 0 };
let luluTokenCache    = { token: null, expiresAt: 0 };

// Retry helper for cold-start resilience: a freshly-spun isolate's first upstream
// call (token exchange / Admin API) can fail transiently. Retry up to `retries`
// times with a fixed delay before giving up.
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
      /^https:\/\/[\w-]+\.github\.io(\/|$)/.test(origin) ||
      /^https?:\/\/localhost(:\d+)?(\/|$)/.test(origin) ||
      /^https:\/\/[\w-]+\.YOUR-ACCOUNT\.workers\.dev(\/|$)/.test(origin) ||
      /^https:\/\/[\w-]+\.your-store\.com(\/|$)/.test(origin);

    const cors = {
      "Access-Control-Allow-Origin":  originOk ? (origin || selfOrigin) : (allowed[0] || ""),
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, anthropic-version, anthropic-dangerous-direct-browser-access",
      "Access-Control-Max-Age":       "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // ── Shopify webhooks ──────────────────────────────────────────────────────
    // Shopify-originated webhooks do NOT carry WORKER_SECRET — they are signed by
    // Shopify with the app's client secret (HMAC-SHA256). The HMAC check inside the
    // handler IS the auth for this route, so it must run BEFORE the Bearer gate.
    if (request.method === "POST" && new URL(request.url).pathname === "/webhooks/shopify/orders-paid") {
      return handleOrdersPaidWebhook(request, env, cors);
    }

    // ── Bearer token auth ─────────────────────────────────────────────────────
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
        worker: "cpaws-multi-proxy",
        routes: ["/shopify/*", "/anthropic/*", "/lulu/*"],
        shopifyAuth: "client-credentials (auto-refresh)",
        auth: expectedSecret ? "bearer-required" : "WARNING: open — set WORKER_SECRET"
      }, 200, cors);
    }

    if (/^\/anthropic(\/|$)/.test(url.pathname)) {
      return handleAnthropic(request, env, url, cors);
    }

    if (/^\/lulu(\/|$)/.test(url.pathname)) {
      return handleLulu(request, env, url, cors);
    }

    return handleShopify(request, env, url, cors, store);
  },
};

// ── Shopify token exchange (client credentials, Dev Dashboard apps) ───────────
// Shopify Dev Dashboard apps (Jan 2026+) no longer show a static token in the UI.
// Instead, exchange SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET for a 24h token.
// This runs server-side in the Worker; the token is cached and refreshed automatically.
// The user never sees or copies a Shopify token.
async function getShopifyToken(env, store) {
  const now = Date.now();
  // Return cached token if it has more than 5 minutes of life remaining
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

  // expires_in is always 86399 (24h). Refresh 5 minutes early (300s buffer).
  const ttl = (Number(data.expires_in) || 86399) * 1000;
  shopifyTokenCache = {
    token:     data.access_token,
    expiresAt: now + ttl - (5 * 60 * 1000),
  };

  return shopifyTokenCache.token;
}

// ── Shopify ───────────────────────────────────────────────────────────────────
async function handleShopify(request, env, url, cors, store) {
  const path = url.pathname.replace(/^\/(shopify\/)?/, "");

  if (!path || path === "health") {
    return respond({
      ok: true, store, apiVersion: API_VERSION,
      worker: "cpaws-shopify-proxy",
      shopifyAuth: "client-credentials (auto-refresh, no token visible to user)",
      endpoints: [
        "POST products/create", "POST products/update", "POST products/publish",
        "POST sync/book", "GET products/:id",
      ],
    }, 200, cors);
  }

  // ── Structured product endpoints ──────────────────────────────────────────
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

  // ── Allowlisted REST proxy (auxiliary reads) ──────────────────────────────
  if (!ALLOWED_PATHS.some(re => re.test(path))) {
    return respond({ error: "Path not permitted: /" + path }, 403, cors);
  }

  let token;
  try { token = await getShopifyToken(env, store); }
  catch (e) { return respond({ error: String(e.message || e) }, 502, cors); }

  const shopifyUrl = `https://${store}.myshopify.com/admin/api/${API_VERSION}/${path}${url.search}`;
  let body;
  if (["POST", "PUT", "PATCH"].includes(request.method)) body = await request.text();

  let shopifyResp;
  try {
    shopifyResp = await fetch(shopifyUrl, {
      method: request.method,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body,
    });
  } catch (e) {
    return respond({ error: "Upstream error: " + String(e.message || e) }, 502, cors);
  }

  const text = await shopifyResp.text();
  return new Response(text, {
    status: shopifyResp.status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// ── Shopify Admin GraphQL helper ─────────────────────────────────────────────
// Token is fetched (or returned from cache) automatically — never visible to the user.
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
        "X-Shopify-Access-Token": token, // injected server-side from token cache, never in browser
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
const adminUrl = (store, gid) => `https://${store}.myshopify.com/admin/products/${numericId(gid)}`;

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

async function shopifyCreate(request, env, cors, store) {
  let body;
  try { body = await request.json(); } catch { return respond({ error: "Invalid JSON body." }, 400, cors); }

  const query = `
    mutation cpawsProductCreate($input: ProductInput!, $media: [CreateMediaInput!]) {
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

async function shopifyUpdate(request, env, cors, store) {
  let body;
  try { body = await request.json(); } catch { return respond({ error: "Invalid JSON body." }, 400, cors); }
  if (!body.productId) return respond({ error: "productId is required." }, 400, cors);

  const input = productInput(body);
  input.id = body.productId;

  const query = `
    mutation cpawsProductUpdate($input: ProductInput!) {
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
    ? `mutation cpawsPublish($id: ID!, $input: [PublicationInput!]!) {
         publishablePublish(id: $id, input: $input) {
           publishable { ... on Product { ${PRODUCT_FIELDS} } }
           userErrors { field message }
         }
       }`
    : `mutation cpawsUnpublish($id: ID!, $input: [PublicationInput!]!) {
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

async function shopifySyncBook(request, env, cors, store) {
  let body;
  try { body = await request.json(); } catch { return respond({ error: "Invalid JSON body." }, 400, cors); }

  const isDoc = body.kind === "document";
  const existing = body.existingProductId;

  // Build base product input
  const input = productInput(body);
  if (existing) input.id = existing;

  if (isDoc) {
    // ── Document: single variant, no Lulu ──────────────────────────────────
    if (body.fileUrl) {
      if (!input.metafields) input.metafields = [];
      input.metafields.push({ namespace: "custom", key: "file_url", type: "single_line_text_field", value: body.fileUrl });
    }
    const innerReq = new Request(request.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, ...(existing ? { productId: existing } : {}) }),
    });
    const resp = existing
      ? await shopifyUpdate(innerReq, env, cors, store)
      : await shopifyCreate(innerReq, env, cors, store);
    if (resp.status !== 200) return resp;
    const data = await resp.json();
    return respond({ ...data, action: existing ? "updated" : "created" }, 200, cors);
  }

  // ── Book: two variants — Digital Download (EPUB) + Print (Lulu POD) ──────
  const hasPrint = !!(body.hasPrint && body.podPackageId && body.interiorUrl && body.coverUrl);

  if (existing) {
    // Update product fields first
    const updateInput = { ...input };
    if (!updateInput.metafields) updateInput.metafields = [];
    if (hasPrint) {
      updateInput.metafields.push(
        { namespace: "custom", key: "_lulu_pod_package_id", type: "single_line_text_field", value: body.podPackageId },
        { namespace: "custom", key: "_lulu_interior_url",   type: "single_line_text_field", value: body.interiorUrl },
        { namespace: "custom", key: "_lulu_cover_url",      type: "single_line_text_field", value: body.coverUrl },
      );
    }
    const updQuery = `
      mutation cpawsProductUpdate($input: ProductInput!) {
        productUpdate(input: $input) {
          product { ${PRODUCT_FIELDS} }
          userErrors { field message }
        }
      }`;
    const { ok, status, json } = await shopifyGraphQL(env, store, updQuery, { input: updateInput });
    const result = json && json.data && json.data.productUpdate;
    if (!ok || (json && json.errors) || (result && result.userErrors && result.userErrors.length)) {
      return respond({ error: "productUpdate failed", details: (json && json.errors) || (result && result.userErrors) }, status === 200 ? 422 : status, cors);
    }
    return respond({ ...shapeProduct(store, result.product), action: "updated" }, 200, cors);
  }

  // Create new product with options and two variants
  const createInput = { ...input };
  // Add Lulu metafields at product level for webhook handler to read
  if (!createInput.metafields) createInput.metafields = [];
  if (hasPrint) {
    createInput.metafields.push(
      { namespace: "custom", key: "_lulu_pod_package_id", type: "single_line_text_field", value: body.podPackageId },
      { namespace: "custom", key: "_lulu_interior_url",   type: "single_line_text_field", value: body.interiorUrl },
      { namespace: "custom", key: "_lulu_cover_url",      type: "single_line_text_field", value: body.coverUrl },
    );
  }

  // Use productCreate with variants
  const variantsMutation = `
    mutation cpawsBookCreate($input: ProductInput!, $media: [CreateMediaInput!]) {
      productCreate(input: $input, media: $media) {
        product {
          id title handle status onlineStoreUrl
          variants(first: 5) { edges { node { id title sku } } }
        }
        userErrors { field message }
      }
    }`;

  // Add variants to input
  createInput.variants = [
    { title: "Digital Download", sku: `${body.handle || body.code}-digital`, price: String(body.price || "9.99"), requiresShipping: false, taxable: true, inventoryManagement: null },
    ...(hasPrint ? [{ title: "Print", sku: `${body.handle || body.code}-print`, price: String(Number(body.price || 9.99) + 10), requiresShipping: true, taxable: true, inventoryManagement: null }] : []),
  ];
  // Remove conflicting price/sku from top-level (variants override)
  delete createInput.price;
  delete createInput.sku;

  const { ok, status, json } = await shopifyGraphQL(env, store, variantsMutation, {
    input: createInput,
    media: mediaInput(body.images),
  });
  const result = json && json.data && json.data.productCreate;
  if (!ok || (json && json.errors) || (result && result.userErrors && result.userErrors.length)) {
    return respond({ error: "productCreate (book) failed", details: (json && json.errors) || (result && result.userErrors) }, status === 200 ? 422 : status, cors);
  }
  const p = result.product;
  const variantEdges = (p && p.variants && p.variants.edges) || [];
  const digitalVariant = variantEdges.find(e => e.node.title === "Digital Download");
  const printVariant   = variantEdges.find(e => e.node.title === "Print");
  return respond({
    productId: p.id,
    variantId: digitalVariant ? digitalVariant.node.id : (variantEdges[0] ? variantEdges[0].node.id : ""),
    printVariantId: printVariant ? printVariant.node.id : "",
    handle: p.handle,
    url: storefrontUrl(store, p.handle, p.onlineStoreUrl),
    adminUrl: adminUrl(store, p.id),
    action: "created",
  }, 200, cors);
}


// ── Shopify Pages sync (series hub page) ─────────────────────────────────────
// Creates or updates a Shopify CMS Page for the series hub (e.g. /kids-and-dogs).
// Always overwrites the body_html so re-pushing after a revision keeps it current.
// Stores existingPageId in the request so future pushes update rather than duplicate.
async function shopifySyncPage(request, env, cors, store) {
  let body;
  try { body = await request.json(); } catch { return respond({ error: "Invalid JSON body." }, 400, cors); }

  const { seriesName, seriesSlug, bodyHtml, existingPageId } = body;
  if (!seriesName || !bodyHtml) return respond({ error: "seriesName and bodyHtml are required." }, 400, cors);

  const handle = seriesSlug || seriesName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/, "");

  let token;
  try { token = await getShopifyToken(env, store); } catch (e) { return respond({ error: String(e.message || e) }, 502, cors); }

  const shopifyBase = `https://${store}.myshopify.com/admin/api/2024-10`;

  // If we have an existing page ID, try updating it first
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
        url: `https://your-store.com/pages/${p.handle || handle}`,
        adminUrl: `https://admin.shopify.com/store/${store}/pages/${p.id || existingPageId}`,
      }, 200, cors);
    }
    // Fall through to create if update fails (page may have been deleted)
  }

  // Check if a page with this handle already exists to avoid duplicates
  const listResp = await fetchWithRetry(`${shopifyBase}/pages.json?handle=${encodeURIComponent(handle)}&fields=id,handle,title`, {
    headers: { "X-Shopify-Access-Token": token },
  });
  if (listResp.ok) {
    const listData = await listResp.json();
    const existing = listData.pages && listData.pages[0];
    if (existing) {
      // Update existing page found by handle
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
          url: `https://your-store.com/pages/${p.handle || handle}`,
          adminUrl: `https://admin.shopify.com/store/${store}/pages/${p.id}`,
        }, 200, cors);
      }
    }
  }

  // Create new page
  const createResp = await fetchWithRetry(`${shopifyBase}/pages.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({
      page: {
        title: seriesName,
        handle,
        body_html: bodyHtml,
        template_suffix: "book-series",
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
    url: `https://your-store.com/pages/${p.handle || handle}`,
    adminUrl: `https://admin.shopify.com/store/${store}/pages/${p.id}`,
  }, 200, cors);
}

async function shopifyGetProduct(productId, env, cors, store) {
  const gid = /^gid:\/\//.test(productId) ? productId : `gid://shopify/Product/${productId}`;
  const query = `query cpawsProduct($id: ID!) { product(id: $id) { id title status handle onlineStoreUrl } }`;
  const { ok, status, json } = await shopifyGraphQL(env, store, query, { id: gid });
  const p = json && json.data && json.data.product;
  if (!ok || (json && json.errors)) {
    return respond({ error: "product fetch failed", details: json && json.errors }, status === 200 ? 422 : status, cors);
  }
  if (!p) return respond({ error: "Product not found." }, 404, cors);
  return respond({ id: p.id, title: p.title, status: p.status, handle: p.handle, url: storefrontUrl(store, p.handle, p.onlineStoreUrl) }, 200, cors);
}

// ── Anthropic ────────────────────────────────────────────────────────────────
async function handleAnthropic(request, env, url, cors) {
  const path = url.pathname.replace(/^\/anthropic\/?/, "");

  if (!ANTHROPIC_ALLOWED_PATHS.some(re => re.test(path))) {
    return respond({ error: "Anthropic path not permitted: /" + path }, 403, cors);
  }
  if (!env.ANTHROPIC_API_KEY) {
    return respond({ error: "ANTHROPIC_API_KEY secret is not set." }, 500, cors);
  }

  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.delete("anthropic-dangerous-direct-browser-access");
  headers.delete("Host");
  headers.delete("Origin");   // prevent Anthropic treating this as a browser-direct request
  headers.set("x-api-key", env.ANTHROPIC_API_KEY);
  headers.set("anthropic-version", headers.get("anthropic-version") || "2023-06-01");

  let body;
  if (!["GET", "HEAD"].includes(request.method)) body = await request.text();

  let resp;
  try {
    resp = await fetch(`${ANTHROPIC_BASE}/${path}${url.search}`, { method: request.method, headers, body });
  } catch (e) {
    return respond({ error: "Upstream error: " + String(e.message || e) }, 502, cors);
  }

  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: { ...cors, "Content-Type": resp.headers.get("Content-Type") || "application/json" },
  });
}

// ── Lulu ──────────────────────────────────────────────────────────────────────
async function getLuluToken(env) {
  const now = Date.now();
  if (luluTokenCache.token && now < luluTokenCache.expiresAt) return luluTokenCache.token;

  const form = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     env.LULU_CLIENT_KEY,
    client_secret: env.LULU_CLIENT_SECRET,
  });

  const resp = await fetchWithRetry(LULU_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Lulu token exchange failed (HTTP ${resp.status}): ${detail}`);
  }
  const data = await resp.json();
  const ttl = (Number(data.expires_in) || 300) * 1000;
  luluTokenCache = { token: data.access_token, expiresAt: now + ttl - 30000 };
  return luluTokenCache.token;
}

async function fetchProductMetafields(env, store, variantGid) {
  // Given a variant GID, fetch the parent product's custom metafields for Lulu POD
  const query = `
    query cpawsVariantMeta($id: ID!) {
      productVariant(id: $id) {
        product {
          metafields(first: 10, namespace: "custom") {
            edges { node { key value } }
          }
        }
      }
    }`;
  const { json } = await shopifyGraphQL(env, store, query, { id: variantGid });
  const edges = json && json.data && json.data.productVariant && json.data.productVariant.product &&
    json.data.productVariant.product.metafields && json.data.productVariant.product.metafields.edges || [];
  const meta = {};
  edges.forEach(e => { meta[e.node.key] = e.node.value; });
  return meta;
}

async function handleLulu(request, env, url, cors) {
  const path = url.pathname.replace(/^\/lulu\/?/, "");
  const match = LULU_ALLOWED.find(a => a.method === request.method && a.re.test(path));
  if (!match) return respond({ error: `Lulu path not permitted: ${request.method} /` + path }, 403, cors);
  if (!env.LULU_CLIENT_KEY || !env.LULU_CLIENT_SECRET) {
    return respond({ error: "LULU_CLIENT_KEY / LULU_CLIENT_SECRET secrets are not set." }, 500, cors);
  }

  let token;
  try { token = await getLuluToken(env); }
  catch (e) { return respond({ error: String(e.message || e) }, 502, cors); }

  let body;
  if (!["GET", "HEAD"].includes(request.method)) body = await request.text();

  let resp;
  try {
    resp = await fetch(`${LULU_BASE}/${path}${url.search}`, {
      method: request.method,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": request.headers.get("Content-Type") || "application/json",
        "Accept": "application/json",
      },
      body,
    });
  } catch (e) {
    return respond({ error: "Upstream error: " + String(e.message || e) }, 502, cors);
  }

  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: { ...cors, "Content-Type": resp.headers.get("Content-Type") || "application/json" },
  });
}

// ── Shopify webhooks ────────────────────────────────────────────────────────
// Shopify signs each webhook with the app's client secret (HMAC-SHA256) and sends
// the base64 digest in the X-Shopify-Hmac-Sha256 header. SHOPIFY_CLIENT_SECRET is
// that same client secret — it doubles as the webhook signing key.
async function verifyShopifyWebhook(request, secret) {
  const hmac = request.headers.get("X-Shopify-Hmac-Sha256");
  if (!hmac) return false;
  const body = await request.clone().arrayBuffer();
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, body);
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return hmac === expected;
}

// POST /webhooks/shopify/orders-paid
// Fires when a Shopify order is paid. For each line item that carries a
// `_lulu_pod_package_id` property (set by Book Studio on the print variant),
// the Worker constructs and fires a Lulu print job via POST /print-jobs/.
//
// Required Shopify line-item properties (set on the print variant in Book Studio):
//   _lulu_pod_package_id  — Lulu 27-char SKU  e.g. "0600X0900BWSTDPB060UW444MXX"
//   _lulu_interior_url    — publicly-accessible URL to the interior PDF (Firebase Storage)
//   _lulu_cover_url       — publicly-accessible URL to the cover PDF    (Firebase Storage)
//
// Optional line-item properties:
//   _book_code            — your internal book code (forwarded to Lulu as external_id)
//
// Shipping address mapping: Shopify order.shipping_address → Lulu shipping_address.
// shipping_level defaults to MAIL; override with _lulu_shipping_level property on the item.
//
// Register in Shopify: Admin → Settings → Notifications → Webhooks → Create webhook
//   Event: Order payment
//   URL:   https://your-shopify-worker.YOUR-ACCOUNT.workers.dev/webhooks/shopify/orders-paid
async function handleOrdersPaidWebhook(request, env, cors) {
  const store = (env.SHOPIFY_STORE || "your-store").trim();
  // ── 1. Verify Shopify HMAC signature ────────────────────────────────────────
  const secret = (env.SHOPIFY_CLIENT_SECRET || "").trim();
  if (!secret) {
    return respond({ error: "SHOPIFY_CLIENT_SECRET secret is not set." }, 500, cors);
  }
  if (!(await verifyShopifyWebhook(request, secret))) {
    return respond({ error: "Invalid webhook signature." }, 401, cors);
  }

  // ── 2. Parse order ───────────────────────────────────────────────────────────
  let order;
  try { order = await request.json(); } catch { return respond({ error: "Invalid JSON body." }, 400, cors); }

  // ── 3. Build Lulu shipping address from Shopify order.shipping_address ───────
  const sa = order.shipping_address || order.billing_address || {};
  const luluAddress = {
    name:         sa.name          || [sa.first_name, sa.last_name].filter(Boolean).join(" ") || "Customer",
    street1:      sa.address1      || "",
    street2:      sa.address2      || undefined,
    city:         sa.city          || "",
    state_code:   sa.province_code || sa.province || "",
    country_code: sa.country_code  || "US",
    postcode:     sa.zip           || sa.postal_code || "",
    phone_number: sa.phone         || order.phone || order.customer?.phone || "000-000-0000",
  };
  // Remove undefined fields (Lulu rejects unknown nulls)
  if (!luluAddress.street2) delete luluAddress.street2;

  // ── 4. Collect POD line items ────────────────────────────────────────────────
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
  const luluLineItems = [];
  const skipped = [];

  for (const item of lineItems) {
    const props = Array.isArray(item.properties) ? item.properties : [];
    const prop = (name) => {
      const p = props.find(pr => pr && pr.name === name);
      return p ? String(p.value || "").trim() : null;
    };

    const podPackageId  = prop("_lulu_pod_package_id");
    const interiorUrl   = prop("_lulu_interior_url");
    const coverUrl      = prop("_lulu_cover_url");
    const bookCode      = prop("_book_code");
    const shippingLevel = prop("_lulu_shipping_level") || "MAIL";

    // If no line-item property, try to read from the product's metafields via variant GID
    let resolvedPodId = podPackageId;
    let resolvedInteriorUrl = interiorUrl;
    let resolvedCoverUrl = coverUrl;
    if ((!resolvedPodId || !resolvedInteriorUrl || !resolvedCoverUrl) && item.variant_id && env.LULU_CLIENT_KEY) {
      try {
        const variantGid = `gid://shopify/ProductVariant/${item.variant_id}`;
        const meta = await fetchProductMetafields(env, store, variantGid);
        resolvedPodId = resolvedPodId || meta["_lulu_pod_package_id"] || null;
        resolvedInteriorUrl = resolvedInteriorUrl || meta["_lulu_interior_url"] || null;
        resolvedCoverUrl = resolvedCoverUrl || meta["_lulu_cover_url"] || null;
      } catch (e) { /* non-fatal */ }
    }

    if (!resolvedPodId) {
      // Not a print POD item — digital download or physical non-Lulu item; skip silently.
      continue;
    }
    if (!resolvedInteriorUrl || !resolvedCoverUrl) {
      skipped.push({ title: item.title, reason: "missing _lulu_interior_url or _lulu_cover_url" });
      continue;
    }

    luluLineItems.push({
      external_id:    bookCode || `shopify-${order.id}-${item.id}`,
      pod_package_id: resolvedPodId,
      quantity:       item.quantity || 1,
      interior:       { source_url: resolvedInteriorUrl },
      cover:          { source_url: resolvedCoverUrl },
      _shipping_level: shippingLevel, // stash per-item; used below
    });
  }

  if (!luluLineItems.length) {
    return respond({
      status: "skipped",
      message: "No print-on-demand items in order",
      skipped,
    }, 200, cors);
  }

  // ── 5. Check Lulu credentials ────────────────────────────────────────────────
  if (!env.LULU_CLIENT_KEY || !env.LULU_CLIENT_SECRET) {
    return respond({ error: "LULU_CLIENT_KEY / LULU_CLIENT_SECRET secrets are not set." }, 500, cors);
  }

  // ── 6. Get Lulu token ────────────────────────────────────────────────────────
  let luluToken;
  try { luluToken = await getLuluToken(env); }
  catch (e) { return respond({ error: "Lulu auth failed: " + String(e.message || e) }, 502, cors); }

  // ── 7. Fire one Lulu print job per unique shipping_level (usually all MAIL) ──
  // Group by shipping level so each job has consistent shipping.
  const byLevel = {};
  for (const li of luluLineItems) {
    const level = li._shipping_level;
    if (!byLevel[level]) byLevel[level] = [];
    const { _shipping_level, ...rest } = li; // strip internal field
    byLevel[level].push(rest);
  }

  const results = [];
  const errors  = [];

  for (const [shippingLevel, items] of Object.entries(byLevel)) {
    const payload = {
      external_id:    `shopify-order-${order.id}`,
      contact_email:  env.LULU_CONTACT_EMAIL || order.email || "orders@your-store.com",
      shipping_level: shippingLevel,
      line_items:     items,
      shipping_address: luluAddress,
    };

    let resp;
    try {
      resp = await fetchWithRetry(`${LULU_BASE}/print-jobs/`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${luluToken}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      errors.push({ shippingLevel, error: String(e.message || e) });
      continue;
    }

    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    if (!resp.ok) {
      errors.push({ shippingLevel, status: resp.status, detail: json });
    } else {
      results.push({ shippingLevel, luluJobId: json.id, status: json.status, items: items.map(i => i.external_id) });
    }
  }

  // ── 8. Return summary ────────────────────────────────────────────────────────
  const httpStatus = errors.length && !results.length ? 502 : 200;
  return respond({
    status:  errors.length ? (results.length ? "partial" : "error") : "submitted",
    orderId: order.id,
    results,
    errors,
    skipped,
  }, httpStatus, cors);
}

function respond(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
