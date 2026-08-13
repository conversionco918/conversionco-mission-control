// Google Search Console integration (dormant until the GOOGLE_* secrets exist).
// One ConversionCo Google account owns ONE console; every client domain is its own
// property inside it. The worker talks to Google as Tiffany via an OAuth refresh token.
// Required worker secrets (created during the one-time Google errand):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN

let tokenCache = { token: null, exp: 0 };

export function gscConfigured(env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
}

export async function gAccessToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Google token: ${data.error_description || data.error || res.status}`);
  tokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

async function gReq(env, method, url, body) {
  const token = await gAccessToken(env);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google ${method} ${url.split('?')[0]} -> ${res.status}: ${data.error?.message || ''}`);
  return data;
}

// ---- property management: domain properties (sc-domain:example.com) ----
export async function gscAddProperty(env, domain) {
  const siteUrl = encodeURIComponent(`sc-domain:${domain}`);
  await gReq(env, 'PUT', `https://www.googleapis.com/webmasters/v3/sites/${siteUrl}`);
  return true;
}

export async function gscListProperties(env) {
  const data = await gReq(env, 'GET', 'https://www.googleapis.com/webmasters/v3/sites');
  return (data.siteEntry || []).map((s) => ({ site: s.siteUrl, permission: s.permissionLevel }));
}

// ---- automated verification for domains on Tiffany's Cloudflare ----
export async function gscVerifyViaCloudflareDns(env, domain) {
  // 1) ask Google for the DNS TXT token
  const tok = await gReq(env, 'POST', 'https://www.googleapis.com/siteVerification/v1/token', {
    site: { type: 'INET_DOMAIN', identifier: domain },
    verificationMethod: 'DNS_TXT',
  });
  const txtValue = tok.token;
  if (!txtValue) throw new Error('no verification token');
  // 2) create the TXT record in Cloudflare (zone must be in her account)
  const zres = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${domain}`, {
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } });
  const zdata = await zres.json();
  const zone = zdata.result?.[0]?.id;
  if (!zone) throw new Error(`domain ${domain} is not a zone in Cloudflare — verify manually or move DNS`);
  await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/dns_records`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'TXT', name: domain, content: txtValue, ttl: 300 }),
  });
  // 3) tell Google to check (may need a retry on the next cron pass — DNS propagation)
  await gReq(env, 'POST', 'https://www.googleapis.com/siteVerification/v1/webResource?verificationMethod=DNS_TXT', {
    site: { type: 'INET_DOMAIN', identifier: domain },
  });
  return true;
}

// ---- manual-DNS path (domains NOT on Cloudflare, e.g. Squarespace DNS) ----
export async function gscGetDnsToken(env, domain) {
  const tok = await gReq(env, 'POST', 'https://www.googleapis.com/siteVerification/v1/token', {
    site: { type: 'INET_DOMAIN', identifier: domain },
    verificationMethod: 'DNS_TXT',
  });
  return tok.token; // value for a TXT record at the domain root
}

export async function gscRequestVerify(env, domain) {
  await gReq(env, 'POST', 'https://www.googleapis.com/siteVerification/v1/webResource?verificationMethod=DNS_TXT', {
    site: { type: 'INET_DOMAIN', identifier: domain },
  });
  return true;
}

// ---- sitemap submission: one API call replaces a manual Search Console chore ----
export async function gscSubmitSitemap(env, domain) {
  const siteUrl = encodeURIComponent(`sc-domain:${domain}`);
  const feed = encodeURIComponent(`https://${domain}/sitemap.xml`);
  await gReq(env, 'PUT', `https://www.googleapis.com/webmasters/v3/sites/${siteUrl}/sitemaps/${feed}`);
  return true;
}

// ---- the numbers: exact positions, impressions, clicks per query ----
export async function gscQueryStats(env, domain, days = 28) {
  const siteUrl = encodeURIComponent(`sc-domain:${domain}`);
  const end = new Date(Date.now() - 2 * 86400000); // GSC data lags ~2 days
  const start = new Date(end.getTime() - days * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const data = await gReq(env, 'POST', `https://www.googleapis.com/webmasters/v3/sites/${siteUrl}/searchAnalytics/query`, {
    startDate: fmt(start), endDate: fmt(end),
    dimensions: ['query'], rowLimit: 12,
  });
  const rows = (data.rows || []).map((r) => ({
    q: r.keys[0],
    pos: Math.round(r.position),
    imp: r.impressions,
    clicks: r.clicks,
  }));
  const totals = rows.reduce((a, r) => ({ imp: a.imp + r.imp, clicks: a.clicks + r.clicks }), { imp: 0, clicks: 0 });
  return { rows, totals, window: `${fmt(start)}..${fmt(end)}` };
}


// ---------------- LP CONNECT: live tag verification (added by Claude 8/12, LP+Ads spec section 3) ----------------
// Fetches a live landing page and verifies the tracking stack is actually on it.
// db is optional: lets us read our own /preview/<slug>/ pages straight from D1
// (a Cloudflare worker cannot fetch its own workers.dev hostname).
export async function lpVerify(url, db) {
  const checks = {
    page: { status: 0, bytes: 0, via: 'fetch' },
    ga4: { present: false, id: '' },
    clarity: { present: false, id: '' },
    events: { call_click: false, sms_click: false, form_submit: false, book_click: false },
    phone: { present: false, number: '' },
  };
  let html = '';
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'ConversionCo-Watchdog/1.0' }, redirect: 'follow' });
    checks.page.status = res.status;
    if (res.ok) html = await res.text();
  } catch (e) {
    checks.page.error = String((e && e.message) || e);
  }
  if (!html && db) {
    const m = url.match(/\/preview\/([^/]+)\/(.+?)(?:[?#]|$)/);
    if (m) {
      try {
        const row = await db.prepare('SELECT content FROM site_files WHERE slug = ? AND path = ?').bind(m[1], m[2]).first();
        if (row && row.content) { html = row.content; checks.page.status = 200; checks.page.via = 'internal'; delete checks.page.error; }
      } catch (e) { /* keep fetch error */ }
    }
  }
  checks.page.bytes = html.length;
  if (html) {
    const ga = html.match(/googletagmanager\.com\/gtag\/js\?id=(G-[A-Z0-9]+)/i);
    if (ga) { checks.ga4.present = true; checks.ga4.id = ga[1]; }
    const cl = html.match(/clarity\.ms\/tag\/([a-zA-Z0-9]+)/);
    if (cl) { checks.clarity.present = true; checks.clarity.id = cl[1]; }
    for (const k of Object.keys(checks.events)) checks.events[k] = html.includes(k);
    const tel = html.match(/href="tel:(\+?[0-9]{7,15})"/);
    if (tel) { checks.phone.present = true; checks.phone.number = tel[1]; }
  }
  const missing = [];
  if (checks.page.status !== 200) missing.push('page not reachable (' + (checks.page.error || checks.page.status || 'no response') + ')');
  if (!checks.ga4.present) missing.push('Google Analytics tag');
  if (!checks.clarity.present) missing.push('Clarity tag');
  for (const [k, v] of Object.entries(checks.events)) if (!v) missing.push(k.replace('_', ' ') + ' handler');
  if (!checks.phone.present) missing.push('tap-to-call number');
  const allGreen = missing.length === 0;
  return {
    allGreen,
    checks,
    missing,
    summary: allGreen ? 'ALL GREEN' : ('missing: ' + missing.join(', ')),
    checkedAt: new Date().toISOString(),
  };
}
