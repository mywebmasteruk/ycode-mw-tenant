// MASJIDWEB: post-deploy CDN cache warmer (fork-only file, no upstream overlap).
//
// WHY: Netlify invalidates the Durable CDN cache when a new production deploy
// goes live (verified live 2026-07-05: every tenant page flipped to
// `cache-status: "Netlify Durable"; fwd=stale` after a deploy, and the first
// visitor per page paid the full 5-7s SSR re-render). Publishes re-warm their
// own tenant (see warmRoutes in lib/services/cacheService.ts), but deploys
// re-cold EVERY tenant at once with nothing re-warming them. This script runs
// from GitHub Actions after each push's deploy goes live and re-primes every
// active tenant's pages so real visitors keep getting CDN hits.
//
// Deliberately dependency-free (plain Node 18+, global fetch) so the workflow
// doesn't need `npm ci` — warming should start as soon after the deploy as
// possible.
//
// Env:
//   NETLIFY_AUTH_TOKEN / NETLIFY_SITE_ID  — wait for the deploy to be live
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — list active tenants
//   GITHUB_SHA        — the commit whose deploy we wait for (optional; latest
//                       ready deploy is used when unset or superseded)
//   MW_DOMAIN_SUFFIX  — default "masjidweb.com"
//   MW_WARM_URLS_PER_TENANT — sitemap URLs warmed per tenant (default 20)

const NETLIFY_AUTH_TOKEN = process.env.NETLIFY_AUTH_TOKEN?.trim();
const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID?.trim();
const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const GITHUB_SHA = process.env.GITHUB_SHA?.trim();
const DOMAIN_SUFFIX = process.env.MW_DOMAIN_SUFFIX?.trim() || 'masjidweb.com';
const URLS_PER_TENANT = clampInt(process.env.MW_WARM_URLS_PER_TENANT, 20, 1, 200);

const DEPLOY_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
const DEPLOY_POLL_INTERVAL_MS = 20 * 1000;
const FETCH_TIMEOUT_MS = 30 * 1000;
const TENANT_CONCURRENCY = 4;

// Match what real browsers send: `netlify-vary` includes accept-encoding, so
// warming with a non-browser encoding set would populate a cache bucket no
// real visitor ever reads (verified live 2026-07-05 — a no-accept-encoding
// probe saw "stale" while browser-shaped requests got the warmed hit).
const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (compatible; MasjidWebCacheWarmer/1.0; +https://masjidweb.com)',
  'accept-encoding': 'gzip, deflate, br, zstd',
  accept: 'text/html,application/xhtml+xml',
};

function clampInt(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function log(msg) {
  console.log(`[warm] ${msg}`);
}

async function fetchWithTimeout(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/**
 * Wait until the Netlify production deploy for GITHUB_SHA (or, failing that,
 * any newer ready deploy) is live. Non-fatal on timeout: warming stale-but-
 * serving pages early is harmless, skipping warming entirely is the real cost.
 */
async function waitForDeploy() {
  if (!NETLIFY_AUTH_TOKEN || !NETLIFY_SITE_ID) {
    log('NETLIFY_AUTH_TOKEN / NETLIFY_SITE_ID not set — skipping deploy wait.');
    return;
  }
  const started = Date.now();
  const deadline = started + DEPLOY_WAIT_TIMEOUT_MS;
  // Right after a push, Netlify may not have created the deploy record yet —
  // don't fall back to "latest ready deploy" until it has had time to appear,
  // or we'd warm the PREVIOUS deploy and get re-colded when ours lands.
  const fallbackAfter = started + 5 * 60 * 1000;
  const api = `https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/deploys?per_page=10`;

  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(api, {
        headers: { authorization: `Bearer ${NETLIFY_AUTH_TOKEN}` },
      });
      if (res.ok) {
        const deploys = await res.json();
        const ours = GITHUB_SHA
          ? deploys.find((d) => d.commit_ref === GITHUB_SHA)
          : undefined;
        if (ours?.state === 'ready') {
          log(`deploy for ${GITHUB_SHA.slice(0, 7)} is live.`);
          return;
        }
        if (ours && ['error', 'failed'].includes(ours.state)) {
          log(`deploy for ${GITHUB_SHA.slice(0, 7)} ${ours.state} — nothing new went live; warming current deploy anyway.`);
          return;
        }
        // Our deploy may have been superseded/skipped: after the grace period,
        // any ready deploy is close enough.
        if (!ours && Date.now() > fallbackAfter && deploys[0]?.state === 'ready') {
          log(`no deploy found for this commit; latest ready deploy is ${String(deploys[0].commit_ref).slice(0, 7)} — proceeding.`);
          return;
        }
      } else {
        log(`Netlify API ${res.status} while polling deploys (will retry).`);
      }
    } catch (e) {
      log(`deploy poll failed (${e?.message ?? e}) — retrying.`);
    }
    await new Promise((r) => setTimeout(r, DEPLOY_POLL_INTERVAL_MS));
  }
  log('timed out waiting for the deploy — warming whatever is live now.');
}

/** List active tenant slugs from tenant_registry via Supabase REST. */
async function listActiveTenantSlugs() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are required');
  }
  const res = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/tenant_registry?select=slug&status=eq.active&slug=not.is.null`,
    { headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` } },
  );
  if (!res.ok) {
    throw new Error(`tenant_registry query failed: ${res.status} ${await res.text()}`);
  }
  const rows = await res.json();
  return [...new Set(
    rows
      .map((r) => (typeof r.slug === 'string' ? r.slug.trim().toLowerCase() : ''))
      // Slug becomes the subdomain we crawl — only accept a plain DNS label so
      // a malformed registry row can never point our GETs at another host.
      .filter((s) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s)),
  )];
}

/** Homepage + up to URLS_PER_TENANT same-host URLs from the tenant's sitemap. */
async function urlsForTenant(host) {
  const base = `https://${host}`;
  const urls = [`${base}/`];
  try {
    const res = await fetchWithTimeout(`${base}/sitemap.xml`, { headers: BROWSER_HEADERS });
    if (res.ok) {
      const xml = await res.text();
      for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
        if (urls.length > URLS_PER_TENANT) break;
        try {
          // The tenant sitemaps emit RELATIVE locs (e.g. "/posts/foo"), so
          // resolve against the site base — bare new URL(loc) throws on those
          // and silently reduced this crawl to homepages only.
          const u = new URL(m[1], base);
          if (u.host === host && !urls.includes(u.toString())) urls.push(u.toString());
        } catch { /* skip malformed loc */ }
      }
    }
  } catch { /* no sitemap — homepage only */ }
  return urls;
}

/** Warm one tenant: sequential GETs (each re-render is the expensive part). */
async function warmTenant(slug) {
  const host = `${slug}.${DOMAIN_SUFFIX}`;
  const urls = await urlsForTenant(host);
  let hits = 0;
  let rendered = 0;
  let failed = 0;
  for (const url of urls) {
    const started = Date.now();
    try {
      const res = await fetchWithTimeout(url, { headers: BROWSER_HEADERS });
      const ms = Date.now() - started;
      const cs = res.headers.get('cache-status') ?? '';
      if (!res.ok) failed += 1;
      else if (/\bhit\b/i.test(cs) && !/fwd=stale/i.test(cs)) hits += 1;
      else rendered += 1;
      if (!res.ok) log(`  ${url} -> HTTP ${res.status} in ${ms}ms`);
      // Drain the body so the CDN finishes writing its cache entry.
      await res.arrayBuffer().catch(() => null);
    } catch (e) {
      failed += 1;
      log(`  ${url} -> ${e?.message ?? e}`);
    }
  }
  log(`${host}: ${urls.length} url(s) — ${rendered} re-rendered, ${hits} already warm, ${failed} failed`);
  return { urls: urls.length, rendered, hits, failed };
}

async function main() {
  await waitForDeploy();

  const slugs = await listActiveTenantSlugs();
  log(`warming ${slugs.length} active tenant(s), up to ${URLS_PER_TENANT} sitemap URL(s) each.`);

  const totals = { urls: 0, rendered: 0, hits: 0, failed: 0 };
  const queue = [...slugs];
  const workers = Array.from({ length: TENANT_CONCURRENCY }, async () => {
    for (let slug = queue.shift(); slug; slug = queue.shift()) {
      const r = await warmTenant(slug);
      totals.urls += r.urls;
      totals.rendered += r.rendered;
      totals.hits += r.hits;
      totals.failed += r.failed;
    }
  });
  await Promise.all(workers);

  log(`done: ${totals.urls} url(s) across ${slugs.length} tenant(s) — ${totals.rendered} re-rendered, ${totals.hits} already warm, ${totals.failed} failed.`);
  // Failures are logged, not fatal: warming is best-effort and pages self-warm
  // on first visit. Only a total inability to run (bad creds) exits non-zero,
  // via the throw in listActiveTenantSlugs.
}

main().catch((e) => {
  console.error(`[warm] fatal: ${e?.message ?? e}`);
  process.exit(1);
});
