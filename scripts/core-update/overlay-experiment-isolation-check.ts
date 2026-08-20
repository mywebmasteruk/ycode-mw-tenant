/**
 * Two-tenant public isolation check against the overlay experiment deploy.
 *
 * Does not steal production DNS. Sends a secret-gated test Host so the
 * experiment proxy resolves high900 vs assasx7 the same way *.masjidweb.com does.
 *
 *   MW_OVERLAY_TEST_SECRET=... npx tsx scripts/core-update/overlay-experiment-isolation-check.ts
 */
const EXPERIMENT_URL = (
  process.env.EXPERIMENT_URL ||
  'https://experiment-overlay-fail-closed--masjidweb-tenants.netlify.app'
).replace(/\/$/, '');

const SECRET = process.env.MW_OVERLAY_TEST_SECRET?.trim();
const TENANTS = [
  { slug: 'high900', host: 'high900.masjidweb.com', mustInclude: 'Almanaar221900ad' },
  { slug: 'assasx7', host: 'assasx7.masjidweb.com', mustInclude: 'welcome to assasx7' },
] as const;

async function fetchAsTenant(host: string, path: string): Promise<{ status: number; body: string }> {
  if (!SECRET) {
    throw new Error('MW_OVERLAY_TEST_SECRET is required');
  }
  const res = await fetch(`${EXPERIMENT_URL}${path}`, {
    headers: {
      'x-mw-overlay-test-secret': SECRET,
      'x-mw-overlay-test-host': host,
    },
  });
  return { status: res.status, body: await res.text() };
}

function h1(html: string): string | null {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

async function main(): Promise<void> {
  const results: string[] = [];
  let failed = 0;

  const leak = await fetchAsTenant(TENANTS[0].host, '/mw-tenant/3ef8bf9e-4341-426c-9696-ba2c2db7adfa/');
  const leakOk = leak.status === 404;
  results.push(`${leakOk ? 'PASS' : 'FAIL'} leak-path 404 (got ${leak.status})`);
  if (!leakOk) failed += 1;

  const pages: { slug: string; heading: string | null; status: number }[] = [];
  for (const tenant of TENANTS) {
    const page = await fetchAsTenant(tenant.host, '/');
    const heading = h1(page.body);
    const hasMarker = (heading || '').toLowerCase().includes(tenant.mustInclude.toLowerCase())
      || (page.body.includes(tenant.mustInclude));
    const ok = page.status === 200 && hasMarker;
    pages.push({ slug: tenant.slug, heading, status: page.status });
    results.push(
      `${ok ? 'PASS' : 'FAIL'} ${tenant.slug} status=${page.status} h1=${JSON.stringify(heading)}`,
    );
    if (!ok) failed += 1;
  }

  const distinct = new Set(pages.map((p) => p.heading).filter(Boolean));
  const isolated = distinct.size === 2;
  results.push(`${isolated ? 'PASS' : 'FAIL'} two tenants rendered different H1s`);
  if (!isolated) failed += 1;

  for (const line of results) {
    console.log(line);
  }
  if (failed) {
    process.exit(1);
  }
}

void main();
