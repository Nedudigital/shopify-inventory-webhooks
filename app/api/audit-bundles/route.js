/* ---- Vercel runtime & max duration ---- */
export const runtime = 'nodejs';
export const maxDuration = 300;

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

/* ----------------- Env & Redis ----------------- */
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SHOPIFY_STORE       = process.env.SHOPIFY_STORE; // e.g. "armadillotough.myshopify.com"
const ADMIN_API_TOKEN     = process.env.SHOPIFY_ADMIN_API_KEY;
const KLAVIYO_API_KEY     = process.env.KLAVIYO_API_KEY;
const ALERT_LIST_ID       = process.env.KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID;
const PUBLIC_STORE_DOMAIN = process.env.PUBLIC_STORE_DOMAIN || 'armadillotough.com';
const CRON_SECRET         = process.env.CRON_SECRET || ''; // used to authorize Vercel Cron function

function assertEnv() {
  const missing = [];
  if (!SHOPIFY_STORE)   missing.push('SHOPIFY_STORE');
  if (!ADMIN_API_TOKEN) missing.push('SHOPIFY_ADMIN_API_KEY');
  if (!KLAVIYO_API_KEY) missing.push('KLAVIYO_API_KEY');
  if (!ALERT_LIST_ID)   missing.push('KLAVIYO_BACK_IN_STOCK_ALERT_LIST_ID');
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);
}

/* ----------------- Vercel Cron auth & overlap lock ----------------- */
function unauthorized() {
  return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
}

async function ensureCronAuth(req) {
  if (!CRON_SECRET) return true; // allow if not configured
  const auth = req.headers.get('authorization') || '';
  return auth === `Bearer ${CRON_SECRET}`;
}

const LOCK_KEY = 'locks:audit-bundles';
const LOCK_TTL_SECONDS = 15 * 60; // safety window

async function acquireLock() {
  try {
    const res = await redis.set(LOCK_KEY, Date.now(), { nx: true, ex: LOCK_TTL_SECONDS });
    return !!res;
  } catch {
    return false;
  }
}

async function releaseLock() {
  try { await redis.del(LOCK_KEY); } catch {}
}

/* ----------------- utils ----------------- */
function toE164(raw) {
  if (!raw) return null;
  let v = String(raw).trim().replace(/[^\d+]/g, '');
  if (v.startsWith('+')) return /^\+\d{8,15}$/.test(v) ? v : null; // strict E.164
  if (/^0\d{10}$/.test(v)) return '+234' + v.slice(1);            // NG 0XXXXXXXXXX
  if (/^(70|80|81|90|91)\d{8}$/.test(v)) return '+234' + v;        // NG 10-digit
  if (/^\d{10}$/.test(v)) return '+1' + v;                         // US 10-digit
  return null;
}
const emailKey = (e) => `email:${String(e || '').toLowerCase()}`;
const productUrlFrom = (handle) => (handle ? `https://${PUBLIC_STORE_DOMAIN}/products/${handle}` : '');

function hasBundleTag(tagsStr) {
  return String(tagsStr || '')
    .split(',')
    .map(t => t.trim().toLowerCase())
    .includes('bundle');
}

function extractStatusFromTags(tagsStr) {
  const tags = String(tagsStr || '').split(',').map(t => t.trim().toLowerCase());
  if (tags.includes('bundle-out-of-stock')) return 'out-of-stock';
  if (tags.includes('bundle-understocked')) return 'understocked';
  if (tags.includes('bundle-ok'))           return 'ok';
  return null;
}

const RANK = { 'ok': 0, 'understocked': 1, 'out-of-stock': 2 };
function worstStatus(a = 'ok', b = 'ok') {
  return (RANK[a] >= RANK[b]) ? a : b;
}

/* ----------------- Klaviyo ----------------- */
async function subscribeProfilesToList({ listId, email, phoneE164, sms }) {
  if (!KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
  if (!listId) throw new Error('listId missing');
  if (!email) throw new Error('email missing');

  const subscriptions = { email: { marketing: { consent: 'SUBSCRIBED' } } };
  if (sms && phoneE164) subscriptions.sms = { marketing: { consent: 'SUBSCRIBED' } };

  const payload = {
    data: {
      type: 'profile-subscription-bulk-create-job',
      attributes: { profiles: { data: [ { type: 'profile', attributes: { email, ...(sms && phoneE164 ? { phone_number: phoneE164 } : {}), subscriptions } } ] } },
      relationships: { list: { data: { type: 'list', id: listId } } },
    },
  };

  const res = await fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/', {
    method: 'POST',
    headers: {
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      'accept': 'application/json',
      'content-type': 'application/json',
      'revision': '2023-10-15',
    },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Klaviyo subscribe failed: ${res.status} ${res.statusText} :: ${body}`);
  return { ok: true, status: res.status, body };
}

async function updateProfileProperties({ email, properties }) {
  if (!KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
  if (!email) throw new Error('email missing');

  const filter = `equals(email,"${String(email).replace(/"/g, '\\"')}")`;
  const listRes = await fetch(`https://a.klaviyo.com/api/profiles/?filter=${encodeURIComponent(filter)}&page[size]=1`, {
    method: 'GET',
    headers: {
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      'accept': 'application/json',
      'revision': '2023-10-15',
    },
  });
  if (!listRes.ok) {
    const txt = await listRes.text();
    throw new Error(`Profiles lookup failed: ${listRes.status} ${listRes.statusText} :: ${txt}`);
  }
  const listJson = await listRes.json();
  const id = listJson?.data?.[0]?.id;
  if (!id) return { ok: false, status: 404, body: 'profile_not_found', skipped: true };

  const patchRes = await fetch(`https://a.klaviyo.com/api/profiles/${id}/`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      'accept': 'application/json',
      'content-type': 'application/json',
      'revision': '2023-10-15',
    },
    body: JSON.stringify({ data: { type: 'profile', id, attributes: { properties } } }),
  });
  const txt = await patchRes.text();
  if (!patchRes.ok) throw new Error(`Profile PATCH failed: ${patchRes.status} ${patchRes.statusText} :: ${txt}`);
  return { ok: true, status: patchRes.status, body: txt };
}

async function trackKlaviyoEvent({ metricName, email, phoneE164, properties }) {
  if (!KLAVIYO_API_KEY) throw new Error('KLAVIYO_API_KEY missing');
  if (!metricName) throw new Error('metricName missing');

  const body = {
    data: {
      type: 'event',
      attributes: {
        time: new Date().toISOString(),
        properties: properties || {},
        metric: { data: { type: 'metric', attributes: { name: metricName } } },
        profile: { data: { type: 'profile', attributes: { email, ...(phoneE164 ? { phone_number: phoneE164 } : {}) } } },
      },
    },
  };

  const res = await fetch('https://a.klaviyo.com/api/events/', {
    method: 'POST',
    headers: {
      'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      'accept': 'application/json',
      'content-type': 'application/json',
      'revision': '2023-10-15',
    },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Klaviyo event failed: ${res.status} ${res.statusText} :: ${txt}`);
  return { ok: true, status: res.status, body: txt };
}

/* ----------------- Shopify (rate-limited) ----------------- */
let lastApiCall = 0;
const MIN_DELAY_MS = 600; // ~1.67 rps (safe under 2/sec)
async function rateLimitedDelay() {
  const now = Date.now();
  const dt = now - lastApiCall;
  if (dt < MIN_DELAY_MS) await new Promise(r => setTimeout(r, MIN_DELAY_MS - dt));
  lastApiCall = Date.now();
}

async function fetchShopify(endpointOrUrl, method = 'GET', body = null, raw = false) {
  if (!endpointOrUrl || typeof endpointOrUrl !== 'string') {
    throw new Error(`fetchShopify called with invalid endpoint: "${endpointOrUrl}"`);
  }
  await rateLimitedDelay();

  const headers = {
    'X-Shopify-Access-Token': String(ADMIN_API_TOKEN),
    'Content-Type': 'application/json',
  };

  const opts = { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) };
  const url = endpointOrUrl.startsWith('http')
    ? endpointOrUrl
    : `https://${SHOPIFY_STORE}/admin/api/2024-04/${endpointOrUrl.replace(/^\//, '')}`;

  const res = await fetch(url, opts);
  if (!res.ok) {
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 2000));
      lastApiCall = Date.now();
      const retry = await fetch(url, opts);
      if (!retry.ok) {
        const t = await retry.text();
        throw new Error(`Shopify API error after retry: ${retry.status} ${retry.statusText} - ${t}`);
      }
      return raw ? retry : retry.json();
    }
    const t = await res.text();
    throw new Error(`Shopify API error: ${res.status} ${res.statusText} - ${t}`);
  }
  return raw ? res : res.json();
}

// Get ALL products (id, title, handle, tags, variants w/ inventory quantities), 250/page
async function getAllProducts() {
  const fields = encodeURIComponent('id,title,handle,tags,variants');
  let url = `products.json?limit=250&fields=${fields}`;
  const all = [];

  while (url) {
    const res = await fetchShopify(url, 'GET', null, true);
    const json = await res.json();
    if (Array.isArray(json?.products)) all.push(...json.products);
    const link = res.headers.get('link') || res.headers.get('Link');
    url = extractNextUrlFromLinkHeader(link);
  }
  return all;
}

// Parse Shopify Link header; return absolute next URL or empty string
function extractNextUrlFromLinkHeader(linkHeader) {
  if (!linkHeader) return '';
  const parts = linkHeader.split(',');
  for (const p of parts) {
    if (p.includes('rel="next"')) {
      const m = p.match(/<([^>]+)>/);
      if (m && m[1]) return m[1];
    }
  }
  return '';
}

async function getProductMetafields(productId) {
  const res = await fetchShopify(`products/${productId}/metafields.json`);
  if (!res || !Array.isArray(res.metafields)) return null;
  return res.metafields.find((m) => m.namespace === 'custom' && m.key === 'bundle_structure');
}

async function updateProductTags(productId, currentTagsCSV, status) {
  const cleaned = String(currentTagsCSV || '')
    .split(',')
    .map(t => t.trim())
    .filter(tag => !['bundle-ok', 'bundle-understocked', 'bundle-out-of-stock'].includes(tag.toLowerCase()))
    .concat([`bundle-${status}`]);

  await fetchShopify(`products/${productId}.json`, 'PUT', { product: { id: productId, tags: cleaned.join(', ') } });
}

// Rare fallback — when a component variant didn’t appear in our product pages (shouldn’t happen)
async function fetchVariantQty(variantId) {
  const res = await fetchShopify(`variants/${variantId}.json`);
  return Number(res?.variant?.inventory_quantity ?? 0);
}

/* ----------------- Redis helpers (status + subscribers + inv totals) ----------------- */
async function getStatus(productId) {
  return (await redis.get(`status:${productId}`)) || null;
}
async function setStatus(productId, prevStatus, currStatus) {
  await redis.set(`status:${productId}`, { previous: prevStatus, current: currStatus });
}

async function getPrevTotal(productId) {
  const v = await redis.get(`inv_total:${productId}`);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
async function setCurrTotal(productId, total) {
  await redis.set(`inv_total:${productId}`, total);
}

/** Read & merge subscribers saved under BOTH keys */
async function getSubscribersForProduct(prod) {
  const keys = [
    `subscribers:${prod.id}`,
    `subscribers_handle:${prod.handle || ''}`,
  ];
  const lists = await Promise.all(keys.map(async (k) => {
    const v = await redis.get(k);
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      try { return JSON.parse(v); } catch { return []; }
    }
    return [];
  }));

  const map = new Map();
  const keyFor = (s) => toE164(s?.phone || '') || emailKey(s?.email);
  const ts = (s) => Date.parse(s?.last_rearmed_at || s?.subscribed_at || 0);
  for (const list of lists) {
    for (const s of list) {
      const k = keyFor(s);
      if (!k) continue;
      const prev = map.get(k);
      if (!prev || ts(s) >= ts(prev)) map.set(k, s);
    }
  }
  const merged = Array.from(map.values());
  return { merged, keysTried: keys };
}

/** Persist updated subscribers back to BOTH keys */
async function setSubscribersForProduct(prod, subs) {
  await Promise.all([
    redis.set(`subscribers:${prod.id}`, subs, { ex: 90 * 24 * 60 * 60 }),
    redis.set(`subscribers_handle:${prod.handle || ''}`, subs, { ex: 90 * 24 * 60 * 60 }),
  ]);
}

/* ----------------- main audit (catalog-wide) ----------------- */
async function auditCatalog() {
  assertEnv();
  console.log('🔎 Starting full catalog sweep (inventory deltas + bundle tagging)…');
  const start = Date.now();

  // 1) Pull ALL products with variants (one pass, paginated)
  const products = await getAllProducts();
  console.log(`🧾 Products fetched: ${products.length}`);

  // 2) Build a variant_id -> qty index from this single sweep
  const variantQty = new Map();
  for (const p of products) {
    for (const v of (p.variants || [])) {
      variantQty.set(String(v.id), Number(v?.inventory_quantity ?? 0));
    }
  }
  console.log(`📦 Variant index size: ${variantQty.size}`);

  let processed = 0;
  let notificationsSent = 0;
  let smsNotificationsSent = 0;
  let notificationErrors = 0;
  let profileUpdates = 0;
  let tagsUpdated = 0;

  for (const product of products) {
    processed++;
    try {
      const pid = Number(product.id);
      const title = product.title;
      const handle = product.handle;
      const tagsCSV = String(product.tags || '');

      // Product total (sum of variant inventory_quantity)
      const total = (product.variants || []).reduce((acc, v) => acc + Number(v?.inventory_quantity ?? 0), 0);
      const prevTotal = await getPrevTotal(pid);
      const increased = prevTotal == null ? false : total > prevTotal;
      await setCurrTotal(pid, total);

      const isBundle = hasBundleTag(tagsCSV);

      // ---- Bundle-only status calc + tag updates ----
      let finalStatus = null;
      if (isBundle) {
        // Components status from custom.bundle_structure
        let componentsStatus = 'ok';
        const metafield = await getProductMetafields(pid);
        if (metafield?.value) {
          let components = [];
          try { components = JSON.parse(metafield.value); } catch { components = []; }

          const under = [];
          const out = [];

          for (const c of components) {
            if (!c?.variant_id) continue;
            const key = String(c.variant_id);
            let qty = variantQty.has(key) ? Number(variantQty.get(key)) : null;
            if (qty == null) { // rare fallback
              qty = await fetchVariantQty(Number(c.variant_id));
            }
            const req = Number(c?.required_quantity ?? 1);
            if (qty === 0) out.push(c.variant_id);
            else if (qty < req) under.push(c.variant_id);
          }
          if (out.length) componentsStatus = 'out-of-stock';
          else if (under.length) componentsStatus = 'understocked';
        } else {
          componentsStatus = 'ok';
        }

        // Bundle's own inventory summary
        const qtys = (product.variants || []).map(v => Number(v?.inventory_quantity ?? 0));
        const ownTotal = qtys.reduce((a, b) => a + b, 0);
        const anyNegative = qtys.some(q => q < 0);
        const allZero = (product.variants || []).length > 0 && qtys.every(q => q === 0);
        const ownStatus =
          allZero ? 'out-of-stock'
          : (anyNegative || ownTotal < 0) ? 'understocked'
          : 'ok';

        finalStatus = worstStatus(componentsStatus, ownStatus);

        // prev status via Redis, fallback to existing tags
        const prevObj = await getStatus(pid);
        const prevStatus = (prevObj?.current ?? extractStatusFromTags(tagsCSV)) || null;
        await setStatus(pid, prevStatus, finalStatus);

        // Update product tags ONLY for bundles
        await updateProductTags(pid, tagsCSV, finalStatus);
        tagsUpdated++;

        console.log(`📊 [${processed}/${products.length}] ${title} — bundle status: comp=${componentsStatus} own=${ownStatus} ⇒ final=${finalStatus}; total=${total} (prev=${prevTotal ?? 'n/a'}, Δ+? ${increased})`);
      } else {
        console.log(`📊 [${processed}/${products.length}] ${title} — non-bundle; total=${total} (prev=${prevTotal ?? 'n/a'}, Δ+? ${increased})`);
      }

      // ---- Back-in-stock notifications (ALL PRODUCTS) ----
      const { merged: uniqueSubs, keysTried } = await getSubscribersForProduct({ id: pid, handle });
      const pending = uniqueSubs.filter(s => !s?.notified);

      // Notify rule:
      //  - Bundles: notify when finalStatus == 'ok' AND (status flipped to ok OR inventory increased)
      //  - Non-bundles: notify when inventory increased AND total > 0
      let shouldNotify = false;
      if (isBundle) {
        const prevObj = await getStatus(pid);
        const prevWasOk = (prevObj?.previous ?? extractStatusFromTags(tagsCSV)) === 'ok';
        shouldNotify = (finalStatus === 'ok') && (pending.length > 0) && (!prevWasOk || increased);
      } else {
        shouldNotify = (pending.length > 0) && increased && total > 0;
      }

      if (shouldNotify && pending.length > 0) {
        const productUrl = productUrlFrom(handle);
        console.log(`🔔 Back in stock — ${title} — notifying ${pending.length} pending subscribers (keys: ${JSON.stringify(keysTried)})`);
        let processedSubs = 0;

        for (const sub of pending) {
          try {
            const phoneE164 = toE164(sub.phone || '');
            const smsConsent = !!sub.sms_consent && !!phoneE164;

            // 1) Ensure on the ALERT list
            await subscribeProfilesToList({ listId: String(ALERT_LIST_ID), email: sub.email, phoneE164, sms: smsConsent });

            // 2) Stamp last back-in-stock props (best-effort)
            const stampedTitle  = sub.product_title  || title || 'Unknown Product';
            const stampedHandle = sub.product_handle || handle || '';
            const stampedUrl    = sub.product_url    || productUrlFrom(stampedHandle) || productUrl;
            const related_section_url = stampedUrl ? `${stampedUrl}#after-bis` : '';

            try {
              const out = await updateProfileProperties({
                email: sub.email,
                properties: {
                  last_back_in_stock_product_name: stampedTitle,
                  last_back_in_stock_product_url: stampedUrl,
                  last_back_in_stock_related_section_url: related_section_url,
                  last_back_in_stock_product_handle: stampedHandle,
                  last_back_in_stock_product_id: String(pid),
                  last_back_in_stock_notified_at: new Date().toISOString(),
                },
              });
              if (out.ok) profileUpdates++;
            } catch (e) {
              console.warn('⚠️ Profile props write failed, continuing:', e?.message || e);
            }

            // 3) Fire the event used by your flow
            await trackKlaviyoEvent({
              metricName: 'Back in Stock',
              email: sub.email,
              phoneE164,
              properties: {
                product_id: String(pid),
                product_title: stampedTitle,
                product_handle: stampedHandle,
                product_url: stampedUrl,
                related_section_url,
                sms_consent: !!smsConsent,
                source: isBundle ? 'bundle audit (catalog sweep)' : 'catalog sweep',
              },
            });

            // 4) Mark as notified + gentle pacing
            sub.notified = true;
            notificationsSent++;
            if (smsConsent) smsNotificationsSent++;
            if (++processedSubs % 5 === 0) await new Promise(r => setTimeout(r, 250));
          } catch (e) {
            notificationErrors++;
            console.error(`❌ Notify failed for ${sub?.email || '(unknown)'}:`, e?.message || e);
          }
        }
        // write back merged list with updated flags
        await setSubscribersForProduct({ id: pid, handle }, uniqueSubs);
      }
    } catch (err) {
      console.error(`❌ Error on product "${product?.title || product?.id}":`, err?.message || err);
    }
  }

  const totalTime = (Date.now() - start) / 1000;
  console.log('\n✅ Catalog audit complete');
  console.log(`🧾 Products processed: ${processed}`);
  console.log(`🏷️ Bundle tags updated: ${tagsUpdated}`);
  console.log(`📧 Email subs sent: ${notificationsSent}`);
  console.log(`📱 SMS subs sent: ${smsNotificationsSent}`);
  console.log(`🧾 Profile updates: ${profileUpdates}`);
  console.log(`❌ Notify errors: ${notificationErrors}`);
  console.log(`⏱️ ${Math.round(totalTime)}s total`);

  return {
    productsProcessed: processed,
    tagsUpdated,
    notificationsSent,
    smsNotificationsSent,
    profileUpdates,
    notificationErrors,
    totalTimeSeconds: totalTime,
    timestamp: new Date().toISOString(),
  };
}

/* ----------------- GET handler ----------------- */
export async function GET(req) {
  const authed = await ensureCronAuth(req);
  if (!authed) return unauthorized();

  const locked = await acquireLock();
  if (!locked) {
    return NextResponse.json({ success: false, error: 'audit already running' }, { status: 423 });
  }

  try {
    const results = await auditCatalog();
    return NextResponse.json({
      success: true,
      message: 'Catalog sweep complete: inventory deltas (all products) + bundle status tagging.',
      ...results,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error?.message || String(error),
        stack: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
      },
      { status: 500 },
    );
  } finally {
    await releaseLock();
  }
}
