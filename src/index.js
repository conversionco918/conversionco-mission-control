import { Hono } from 'hono';
import { GHL } from './ghl.js';
import { DEFAULT_TEMPLATES, BOOKING_TEMPLATES, DEFAULT_SETTINGS, renderTemplate } from './emails.js';
import { THEMES } from './themes.js';
import { vibeToTokens } from './vibe.js';
import { PRICES, ensureCustomer, sendInvoice, invoiceStatus, hostingCheckout, checkoutStatus } from './stripe.js';
import { computeScore } from './score.js';
import dashboardHtml from './ui.html';
import loginHtml from './login.html';

const app = new Hono();

// ---------------- schema bootstrap (runs once per isolate) ----------------
const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT DEFAULT '', phone TEXT DEFAULT '', business_name TEXT DEFAULT '',
    stage TEXT NOT NULL DEFAULT 'new',
    ghl_contact_id TEXT DEFAULT '',
    intake1_data TEXT DEFAULT '', intake2_data TEXT DEFAULT '',
    preview_url TEXT DEFAULT '', live_url TEXT DEFAULT '', notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER, type TEXT NOT NULL, detail TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS site_files (
    slug TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
    content_type TEXT NOT NULL DEFAULT 'text/html', is_base64 INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (slug, path))`,
  `CREATE INDEX IF NOT EXISTS idx_events_client ON events(client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_clients_stage ON clients(stage)`,
];
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA_SQL.map((s) => db.prepare(s)));
  // additive migrations (safe to fail if the column already exists)
  try { await db.prepare(`ALTER TABLE clients ADD COLUMN theme TEXT DEFAULT ''`).run(); } catch {}
  try { await db.prepare(`ALTER TABLE clients ADD COLUMN tier TEXT DEFAULT 'standard'`).run(); } catch {}
  try { await db.prepare(`ALTER TABLE clients ADD COLUMN launch_checklist TEXT DEFAULT ''`).run(); } catch {}
  try { await db.prepare(`ALTER TABLE clients ADD COLUMN vibe TEXT DEFAULT ''`).run(); } catch {}
  try { await db.prepare(`ALTER TABLE clients ADD COLUMN billing TEXT DEFAULT ''`).run(); } catch {}
  schemaReady = true;
}

app.use('*', async (c, next) => {
  await ensureSchema(c.env.DB);
  return next();
});

// ---------------- helpers ----------------
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, '');
}

async function makeSession(env) {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 30; // 30 days
  const payload = `s:${exp}`;
  return `${payload}.${await hmac(env.SESSION_SECRET, payload)}`;
}

async function checkSession(env, cookie) {
  if (!cookie) return false;
  const m = /cc_session=([^;]+)/.exec(cookie);
  if (!m) return false;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return false;
  if ((await hmac(env.SESSION_SECRET, payload)) !== sig) return false;
  const exp = Number(payload.split(':')[1]);
  return Date.now() < exp;
}

async function getSettings(db) {
  const rows = (await db.prepare('SELECT key, value FROM settings').all()).results || [];
  const s = { ...DEFAULT_SETTINGS, ...DEFAULT_TEMPLATES, ...BOOKING_TEMPLATES };
  for (const r of rows) s[r.key] = r.value;
  return s;
}

async function setSetting(db, key, value) {
  await db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(key, String(value ?? '')).run();
}

async function logEvent(db, clientId, type, detail = '') {
  await db.prepare('INSERT INTO events (client_id, type, detail) VALUES (?, ?, ?)')
    .bind(clientId, type, detail).run();
}

async function touchClient(db, id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  await db.prepare(`UPDATE clients SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...keys.map((k) => fields[k]), id).run();
}

function ghlFor(env, settings) {
  return new GHL(env.GHL_TOKEN, settings.ghl_location_id);
}

// ---------------- direct intake receiver (public, called by the form pages) ----------------
function corsHeaders(c) {
  c.header('Access-Control-Allow-Origin', c.req.header('Origin') || '*');
  c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
}

app.options('/intake/:n', (c) => { corsHeaders(c); return c.body(null, 204); });

app.post('/intake/:n', async (c) => {
  corsHeaders(c);
  const n = c.req.param('n') === '2' ? 2 : 1;
  const db = c.env.DB;
  const ct = c.req.header('Content-Type') || '';
  let fields = {};
  let rawBody = null;
  try {
    if (ct.includes('json')) {
      fields = await c.req.json();
      rawBody = JSON.stringify(fields);
    } else {
      const parsed = await c.req.parseBody();
      for (const [k, v] of Object.entries(parsed)) fields[k] = typeof v === 'string' ? v : '(file)';
    }
  } catch { /* keep going with empty fields */ }

  // normalize: find email/name/phone regardless of exact field naming
  const lower = {};
  for (const [k, v] of Object.entries(fields)) lower[k.toLowerCase().trim()] = typeof v === 'string' ? v : JSON.stringify(v);
  const email = (lower.email || lower['email address'] || lower.e_mail ||
    Object.values(lower).find((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim())) || '').trim();
  const name = lower.name || lower['full name'] || [lower.first_name || lower.firstname, lower.last_name || lower.lastname].filter(Boolean).join(' ') || '';
  const phone = lower.phone || lower['phone number'] || lower.tel || '';

  // never store the web3forms key or bot fields
  const stored = {};
  for (const [k, v] of Object.entries(fields)) {
    if (['access_key', 'botcheck', 'h-captcha-response'].includes(k.toLowerCase())) continue;
    stored[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }

  const dataCol = n === 2 ? 'intake2_data' : 'intake1_data';
  const doneStage = n === 2 ? 'intake2_done' : 'intake1_done';
  const advanceFrom = n === 2
    ? ['new', 'intake1_sent', 'intake1_done', 'intake2_sent']
    : ['new', 'intake1_sent'];

  let clientId = null;
  let firstTime = false;
  if (email) {
    const client = await db.prepare('SELECT * FROM clients WHERE email = ?').bind(email).first();
    if (!client) {
      const r = await db.prepare(
        `INSERT INTO clients (email, name, phone, stage, ${dataCol}) VALUES (?, ?, ?, ?, ?)`
      ).bind(email, name, phone, doneStage, JSON.stringify(stored)).run();
      clientId = r.meta.last_row_id;
      firstTime = true;
      await logEvent(db, clientId, doneStage, `Intake ${n} submitted (new contact)`);
    } else {
      clientId = client.id;
      firstTime = !(client[dataCol] && client[dataCol].length > 2);
      const updates = { [dataCol]: JSON.stringify(stored) };
      if (name && !client.name) updates.name = name;
      if (phone && !client.phone) updates.phone = phone;
      if (advanceFrom.includes(client.stage)) updates.stage = doneStage;
      await touchClient(db, client.id, updates);
      await logEvent(db, client.id, doneStage, `Intake ${n} submission received`);
    }
  } else {
    await logEvent(db, null, 'error', `Intake ${n} submission had no email: ${JSON.stringify(stored).slice(0, 500)}`);
  }

  // After a first-time Intake 1: automatically email the booking link (best effort)
  if (n === 1 && email && firstTime) {
    const settings = await getSettings(db);
    if (settings.booking_link && c.env.GHL_TOKEN && settings.ghl_location_id) {
      const sendBooking = (async () => {
        try {
          const ghl = ghlFor(c.env, settings);
          const contact = await ghl.upsertContact({ email, name, phone });
          const contactId = contact.id || contact.contactId;
          if (clientId && contactId) await touchClient(db, clientId, { ghl_contact_id: contactId });
          const firstName = (name || '').split(' ')[0] || 'there';
          await ghl.sendEmail({
            contactId,
            subject: renderTemplate(settings.booking_subject, { name: firstName }),
            html: renderTemplate(settings.booking_body, { name: firstName, booking_link: settings.booking_link }),
            emailFrom: settings.email_from || undefined,
          });
          await logEvent(db, clientId, 'booking_email_sent', `Booking link sent to ${email}`);
        } catch (e) {
          await logEvent(db, clientId, 'error', `Booking email failed: ${e.message}`);
        }
      })();
      c.executionCtx.waitUntil(sendBooking);
    }
  }

  // forward to Web3Forms so email notifications keep working (best effort)
  if (fields.access_key) {
    const fwd = fetch('https://api.web3forms.com/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: rawBody || JSON.stringify(fields),
    }).catch(() => {});
    c.executionCtx.waitUntil(fwd);
  }

  return c.json({ success: true, message: 'Submission received' });
});

// ---------------- public preview serving (client site previews) ----------------
const MIME = { html: 'text/html;charset=utf-8', css: 'text/css', js: 'application/javascript', json: 'application/json', svg: 'image/svg+xml', xml: 'application/xml', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon', woff2: 'font/woff2' };

app.get('/preview/:slug', (c) => c.redirect(`/preview/${c.req.param('slug')}/index.html`));
app.get('/preview/:slug/', (c) => c.redirect(`/preview/${c.req.param('slug')}/index.html`));
app.get('/preview/:slug/*', async (c) => {
  const slug = c.req.param('slug');
  let path = c.req.path.replace(`/preview/${slug}/`, '') || 'index.html';
  if (path === '' || path.endsWith('/')) path += 'index.html';
  let row = await c.env.DB.prepare('SELECT * FROM site_files WHERE slug = ? AND path = ?').bind(slug, path).first();
  if (!row && !path.includes('.')) {
    row = await c.env.DB.prepare('SELECT * FROM site_files WHERE slug = ? AND path = ?').bind(slug, path + '/index.html').first()
      || await c.env.DB.prepare('SELECT * FROM site_files WHERE slug = ? AND path = ?').bind(slug, path + '.html').first();
  }
  if (!row) return c.text('Not found', 404);
  const body = row.is_base64 ? Uint8Array.from(atob(row.content), (ch) => ch.charCodeAt(0)) : row.content;
  return new Response(body, { headers: { 'Content-Type': row.content_type, 'Cache-Control': 'no-cache' } });
});

// ---------------- auth ----------------
app.post('/login', async (c) => {
  const { password } = await c.req.parseBody();
  if (password !== c.env.DASH_PASSWORD) {
    return c.html(loginHtml.replace('<!--ERROR-->', '<p class="err">Wrong password, try again.</p>'));
  }
  const token = await makeSession(c.env);
  c.header('Set-Cookie', `cc_session=${token}; HttpOnly; Secure; Path=/; Max-Age=2592000; SameSite=Lax`);
  return c.redirect('/');
});

// Webhook from GHL (no session; secret in URL) — optional alternative to polling
app.post('/webhooks/ghl/:secret', async (c) => {
  const settings = await getSettings(c.env.DB);
  const expected = await hmac(c.env.SESSION_SECRET, 'webhook');
  if (c.req.param('secret') !== expected.slice(0, 16)) return c.text('nope', 403);
  const body = await c.req.json().catch(() => ({}));
  await logEvent(c.env.DB, null, 'webhook_received', JSON.stringify(body).slice(0, 4000));
  // Polling is the source of truth; webhook just triggers an immediate poll.
  await pollForms(c.env, settings).catch(() => {});
  return c.json({ ok: true });
});

// Diagnostic endpoint (keyed, GET so it can be fetched externally)
app.get('/debug/:key', async (c) => {
  if (c.req.param('key') !== 'dbg-7c1f4a9e2b') return c.text('nope', 403);
  const db = c.env.DB;
  const settings = await getSettings(db);
  let publishResult = 'ran';
  try { await autoPublish(c.env, settings); } catch (e) { publishResult = 'ERROR: ' + e.message; }
  const events = (await db.prepare('SELECT type, detail, created_at FROM events ORDER BY id DESC LIMIT 12').all()).results || [];
  // repo state diagnostics
  let repoDiag = {};
  try {
    const gh = ghFetcher(c.env);
    const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
    const ref = await gh(`/repos/${repo}/git/ref/heads/main`);
    const commit = await gh(`/repos/${repo}/git/commits/${ref.object.sha}`);
    const tree = await gh(`/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
    const metas = (tree.tree || []).filter((t) => /^sites\/[^/]+\/site-meta\.json$/.test(t.path));
    repoDiag = { head: ref.object.sha.slice(0,10), metas: metas.map(m => ({ path: m.path, sha: m.sha.slice(0,10), stored: (settings['site_sha_' + m.path.split('/')[1]] || 'none').slice(0,10) })) };
  } catch (e) { repoDiag = { error: e.message }; }
  const fileCount = await db.prepare('SELECT COUNT(*) AS n FROM site_files').first();
  return c.json({
    publishResult,
    site_files: fileCount?.n,
    has_github_token: Boolean(c.env.GITHUB_TOKEN),
    sites_repo: settings.sites_repo,
    repoDiag,
    events: events.map((e) => ({ t: e.type, d: (e.detail || '').slice(0, 160), at: e.created_at })),
    uptime: await (async () => {
      const rows = (await c.env.DB.prepare(`SELECT key, value FROM settings WHERE key LIKE 'uptime_%'`).all()).results || [];
      const out = {};
      for (const r of rows) { try { out[r.key] = JSON.parse(r.value); } catch {} }
      return out;
    })(),
    tiers: await (async () => {
      const rows = (await c.env.DB.prepare('SELECT id, email, business_name, tier, stage FROM clients').all()).results || [];
      return rows;
    })(),
    scores: await (async () => {
      const rows = (await c.env.DB.prepare('SELECT * FROM clients').all()).results || [];
      const settings2 = await getSettings(c.env.DB);
      const out = {};
      for (const cl of rows) { try { const sc = await computeScore(c.env.DB, cl, settings2); if (sc) out[cl.id] = sc; } catch {} }
      return out;
    })(),
  });
});

// ---- AI image generation (OpenAI) → commits PNG into the client-sites repo ----
// Keyed endpoint so the builder can trigger it without a browser session.
app.post('/api/genimage/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  if (!c.env.OPENAI_API_KEY) return c.json({ ok: false, error: 'OPENAI_API_KEY secret not set yet' });
  if (!c.env.GITHUB_TOKEN) return c.json({ ok: false, error: 'GITHUB_TOKEN secret not set' });
  const { prompt, slug, name, size = '1024x1536' } = await c.req.json();
  if (!prompt || !slug || !name) return c.json({ ok: false, error: 'prompt, slug, name required' }, 400);
  const settings = await getSettings(c.env.DB);
  const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
  try {
    // try gpt-image-1 first, fall back to dall-e-3
    let b64 = null;
    let modelUsed = 'gpt-image-1';
    let res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-1', prompt, size, quality: 'high' }),
    });
    let data = await res.json();
    if (data?.data?.[0]?.b64_json) {
      b64 = data.data[0].b64_json;
    } else {
      modelUsed = 'dall-e-3';
      res = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'dall-e-3', prompt, size: '1024x1792', quality: 'hd', response_format: 'b64_json' }),
      });
      data = await res.json();
      if (data?.data?.[0]?.b64_json) b64 = data.data[0].b64_json;
      else return c.json({ ok: false, error: JSON.stringify(data?.error || data).slice(0, 400) });
    }
    // commit PNG to GitHub repo
    const path = `sites/${slug}/img/${name}.png`;
    const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' },
    });
    const existing = getRes.ok ? await getRes.json() : null;
    const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Generate ${name}.png (${modelUsed})`, content: b64, ...(existing?.sha ? { sha: existing.sha } : {}) }),
    });
    if (!putRes.ok) return c.json({ ok: false, error: `GitHub commit failed: ${putRes.status}` });
    // also store directly into D1 so the preview serves it immediately
    await c.env.DB.prepare(
      `INSERT INTO site_files (slug, path, content, content_type, is_base64, updated_at)
       VALUES (?, ?, ?, 'image/png', 1, datetime('now'))
       ON CONFLICT(slug, path) DO UPDATE SET content=excluded.content, is_base64=1, updated_at=datetime('now')`
    ).bind(slug, `img/${name}.png`, b64).run();
    return c.json({ ok: true, model: modelUsed, path, preview: `${BASE_URL}/preview/${slug}/img/${name}.png` });
  } catch (e) {
    return c.json({ ok: false, error: e.message }, 502);
  }
});

app.get('/api/genimage/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const q = c.req.query();
  const res = await app.request('/api/genimage/gen-4b8e1d7f3a', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: q.prompt, slug: q.slug, name: q.name, size: q.size }),
  }, c.env, c.executionCtx);
  return res;
});

// Fetch an image from a URL (e.g. a generated render) and store it into a site + GitHub
app.post('/api/fetchimg/:key', async (c) => {
  corsHeaders(c);
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  if (!c.env.GITHUB_TOKEN) return c.json({ ok: false, error: 'GITHUB_TOKEN secret not set' });
  const { url, slug, name } = await c.req.json();
  if (!url || !slug || !name) return c.json({ ok: false, error: 'url, slug, name required' }, 400);
  const settings = await getSettings(c.env.DB);
  const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
  try {
    const imgRes = await fetch(url);
    if (!imgRes.ok) return c.json({ ok: false, error: `fetch ${imgRes.status}` });
    const buf = new Uint8Array(await imgRes.arrayBuffer());
    if (buf.length > 8_000_000) return c.json({ ok: false, error: 'image too large' });
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
    const b64 = btoa(bin);
    const path = `sites/${slug}/img/${name}.png`;
    const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' },
    });
    const existing = getRes.ok ? await getRes.json() : null;
    const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Add ${name}.png`, content: b64, ...(existing?.sha ? { sha: existing.sha } : {}) }),
    });
    if (!putRes.ok) return c.json({ ok: false, error: `GitHub ${putRes.status}` });
    await c.env.DB.prepare(
      `INSERT INTO site_files (slug, path, content, content_type, is_base64, updated_at)
       VALUES (?, ?, ?, 'image/png', 1, datetime('now'))
       ON CONFLICT(slug, path) DO UPDATE SET content=excluded.content, is_base64=1, updated_at=datetime('now')`
    ).bind(slug, `img/${name}.png`, b64).run();
    return c.json({ ok: true, bytes: buf.length, path });
  } catch (e) {
    return c.json({ ok: false, error: e.message }, 502);
  }
});
app.options('/api/fetchimg/:key', (c) => { corsHeaders(c); return c.body(null, 204); });

// Push raw base64 image data (e.g. read out of a page that blocks downloads) → GitHub + D1
app.post('/api/pushimg/:key', async (c) => {
  corsHeaders(c);
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  if (!c.env.GITHUB_TOKEN) return c.json({ ok: false, error: 'GITHUB_TOKEN secret not set' });
  const { b64, slug, name, ext = 'png' } = await c.req.json();
  if (!b64 || !slug || !name) return c.json({ ok: false, error: 'b64, slug, name required' }, 400);
  if (b64.length > 11_000_000) return c.json({ ok: false, error: 'image too large' });
  const clean = b64.replace(/^data:[^,]+,/, '');
  const safeExt = ext === 'webp' ? 'webp' : ext === 'jpg' ? 'jpg' : 'png';
  const mime = safeExt === 'webp' ? 'image/webp' : safeExt === 'jpg' ? 'image/jpeg' : 'image/png';
  const settings = await getSettings(c.env.DB);
  const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
  try {
    const path = `sites/${slug}/img/${name}.${safeExt}`;
    const ghHeaders = { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' };
    const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, { headers: ghHeaders });
    const existing = getRes.ok ? await getRes.json() : null;
    const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Add ${name}.${safeExt}`, content: clean, ...(existing?.sha ? { sha: existing.sha } : {}) }),
    });
    if (!putRes.ok) return c.json({ ok: false, error: `GitHub ${putRes.status}: ${(await putRes.text()).slice(0, 200)}` });
    await c.env.DB.prepare(
      `INSERT INTO site_files (slug, path, content, content_type, is_base64, updated_at)
       VALUES (?, ?, ?, ?, 1, datetime('now'))
       ON CONFLICT(slug, path) DO UPDATE SET content=excluded.content, content_type=excluded.content_type, is_base64=1, updated_at=datetime('now')`
    ).bind(slug, `img/${name}.${safeExt}`, clean, mime).run();
    return c.json({ ok: true, bytes: Math.floor(clean.length * 0.75), path, preview: `${BASE_URL}/preview/${slug}/img/${name}.${safeExt}` });
  } catch (e) {
    return c.json({ ok: false, error: e.message }, 502);
  }
});
app.options('/api/pushimg/:key', (c) => { corsHeaders(c); return c.body(null, 204); });

// GET variant: grab an image URL via top-level navigation (bypasses page CSP)
app.get('/api/grabimg/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const q = c.req.query();
  const res = await app.request('/api/fetchimg/gen-4b8e1d7f3a', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: q.u, slug: q.slug, name: q.name }),
  }, c.env, c.executionCtx);
  const data = await res.json().catch(() => ({}));
  return c.html(`<html><body style="font-family:sans-serif;background:#111;color:#eee;padding:40px">
    <h2>${data.ok ? '✅ SAVED' : '❌ FAILED'}</h2><p>${q.name}: ${data.ok ? data.bytes + ' bytes' : (data.error || 'unknown')}</p>
  </body></html>`);
});

// Everything below requires a session
app.use('*', async (c, next) => {
  if (await checkSession(c.env, c.req.header('Cookie'))) return next();
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'unauthorized' }, 401);
  return c.html(loginHtml.replace('<!--ERROR-->', ''));
});

app.get('/', (c) => c.html(dashboardHtml));

// ---------------- API: clients ----------------
app.get('/api/state', async (c) => {
  const db = c.env.DB;
  const clients = (await db.prepare('SELECT * FROM clients ORDER BY updated_at DESC').all()).results || [];
  const events = (await db.prepare(
    'SELECT e.*, c.name AS client_name, c.email AS client_email FROM events e LEFT JOIN clients c ON c.id = e.client_id ORDER BY e.id DESC LIMIT 50'
  ).all()).results || [];
  const settings = await getSettings(db);
  const webhookSecret = (await hmac(c.env.SESSION_SECRET, 'webhook')).slice(0, 16);
  return c.json({ clients, events, settings, webhook_path: `/webhooks/ghl/${webhookSecret}` });
});

// Add client + send Intake 1
app.post('/api/clients', async (c) => {
  const db = c.env.DB;
  const { email, name, sendNow = true } = await c.req.json();
  if (!email || !/.+@.+\..+/.test(email)) return c.json({ error: 'Valid email required' }, 400);

  const existing = await db.prepare('SELECT * FROM clients WHERE email = ?').bind(email.trim()).first();
  let clientId = existing?.id;
  if (!clientId) {
    const r = await db.prepare('INSERT INTO clients (email, name) VALUES (?, ?)')
      .bind(email.trim(), name || '').run();
    clientId = r.meta.last_row_id;
    await logEvent(db, clientId, 'client_created', email.trim());
  }

  if (!sendNow) return c.json({ ok: true, id: clientId });

  const settings = await getSettings(db);
  if (!settings.ghl_location_id) return c.json({ error: 'Set your GHL Location ID in Settings first.' }, 400);
  const ghl = ghlFor(c.env, settings);

  try {
    const contact = await ghl.upsertContact({ email: email.trim(), name });
    const contactId = contact.id || contact.contactId;
    const firstName = (name || contact.firstName || '').split(' ')[0] || 'there';
    await ghl.sendEmail({
      contactId,
      subject: renderTemplate(settings.intake1_subject, { name: firstName }),
      html: renderTemplate(settings.intake1_body, { name: firstName, form_link: settings.form1_link }),
      emailFrom: settings.email_from || undefined,
    });
    await touchClient(db, clientId, { stage: 'intake1_sent', ghl_contact_id: contactId, name: name || existing?.name || '' });
    await logEvent(db, clientId, 'intake1_sent', `Sent to ${email.trim()}`);
    return c.json({ ok: true, id: clientId });
  } catch (e) {
    await logEvent(db, clientId, 'error', `Intake 1 send failed: ${e.message}`);
    return c.json({ error: e.message }, 502);
  }
});

// Approve after pricing call -> send Intake 2
app.post('/api/clients/:id/send-intake2', async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'Client not found' }, 404);

  const settings = await getSettings(db);
  const ghl = ghlFor(c.env, settings);
  try {
    let contactId = client.ghl_contact_id;
    if (!contactId) {
      const contact = await ghl.upsertContact({ email: client.email, name: client.name });
      contactId = contact.id || contact.contactId;
    }
    const firstName = (client.name || '').split(' ')[0] || 'there';
    // carry the client's email in the form link so their submission auto-matches
    const link2 = settings.form2_link + (settings.form2_link.includes('?') ? '&' : '?') +
      'e=' + encodeURIComponent(client.email);
    await ghl.sendEmail({
      contactId,
      subject: renderTemplate(settings.intake2_subject, { name: firstName }),
      html: renderTemplate(settings.intake2_body, { name: firstName, form_link: link2 }),
      emailFrom: settings.email_from || undefined,
    });
    await touchClient(db, id, { stage: 'intake2_sent', ghl_contact_id: contactId });
    await logEvent(db, id, 'intake2_sent', `Sent to ${client.email}`);
    return c.json({ ok: true });
  } catch (e) {
    await logEvent(db, id, 'error', `Intake 2 send failed: ${e.message}`);
    return c.json({ error: e.message }, 502);
  }
});

// Manual stage change / notes / delete
app.patch('/api/clients/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json();
  const allowed = {};
  for (const k of ['stage', 'notes', 'name', 'phone', 'business_name', 'preview_url', 'live_url', 'theme', 'tier', 'launch_checklist', 'vibe']) {
    if (k in body) allowed[k] = body[k];
  }
  if (!Object.keys(allowed).length) return c.json({ error: 'nothing to update' }, 400);
  await touchClient(c.env.DB, id, allowed);
  if (allowed.stage) await logEvent(c.env.DB, id, 'stage_changed', `Moved to ${allowed.stage}`);
  return c.json({ ok: true });
});

app.delete('/api/clients/:id', async (c) => {
  const id = Number(c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM clients WHERE id = ?').bind(id).run();
  await logEvent(c.env.DB, id, 'client_deleted');
  return c.json({ ok: true });
});

// ---------------- Stripe billing ----------------
function getBilling(client) { try { return JSON.parse(client.billing || '{}'); } catch { return {}; } }

app.post('/api/clients/:id/invoice', async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) return c.json({ error: 'Add the STRIPE_SECRET_KEY secret to the worker first (Cloudflare → worker → Settings → Variables)' }, 400);
  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'client not found' }, 404);
  const tierKey = (client.tier === 'premium') ? 'premium' : 'standard';
  try {
    const cust = await ensureCustomer(c.env.STRIPE_SECRET_KEY, client.email, client.name || client.business_name || '');
    const inv = await sendInvoice(c.env.STRIPE_SECRET_KEY, cust.id, tierKey, client.business_name || '');
    const billing = getBilling(client);
    billing.customer_id = cust.id;
    billing.invoice_id = inv.id; billing.invoice_status = inv.status; billing.invoice_url = inv.url; billing.invoice_tier = tierKey;
    await touchClient(db, id, { billing: JSON.stringify(billing) });
    await logEvent(db, id, 'invoice_sent', `Stripe invoice sent — ${PRICES[tierKey].display} (${PRICES[tierKey].label}) 💳`);
    return c.json({ ok: true, url: inv.url, display: PRICES[tierKey].display });
  } catch (e) {
    return c.json({ error: 'Stripe: ' + e.message }, 502);
  }
});

app.post('/api/clients/:id/hosting', async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) return c.json({ error: 'Add the STRIPE_SECRET_KEY secret to the worker first' }, 400);
  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'client not found' }, 404);
  try {
    const cust = await ensureCustomer(c.env.STRIPE_SECRET_KEY, client.email, client.name || client.business_name || '');
    const ret = client.live_url || client.preview_url || 'https://conversionco918.com';
    const sess = await hostingCheckout(c.env.STRIPE_SECRET_KEY, cust.id, client.business_name || '', ret);
    const billing = getBilling(client);
    billing.customer_id = cust.id;
    billing.sub_session_id = sess.id; billing.sub_link = sess.url; billing.sub_status = 'pending';
    await touchClient(db, id, { billing: JSON.stringify(billing) });
    await logEvent(db, id, 'hosting_link', 'Hosting & security $49/mo — checkout link created 🔒');
    return c.json({ ok: true, url: sess.url });
  } catch (e) {
    return c.json({ error: 'Stripe: ' + e.message }, 502);
  }
});

async function pollBilling(env) {
  if (!env.STRIPE_SECRET_KEY) return 0;
  const db = env.DB;
  const clients = (await db.prepare(`SELECT * FROM clients WHERE billing LIKE '%"invoice_status":"open"%' OR billing LIKE '%"sub_status":"pending"%'`).all()).results || [];
  let changed = 0;
  for (const client of clients) {
    const billing = getBilling(client);
    try {
      if (billing.invoice_id && billing.invoice_status === 'open') {
        const st = await invoiceStatus(env.STRIPE_SECRET_KEY, billing.invoice_id);
        if (st.status !== billing.invoice_status) {
          billing.invoice_status = st.status;
          if (st.paid) {
            billing.paid_at = new Date().toISOString();
            await logEvent(db, client.id, 'invoice_paid', `Invoice PAID — ${PRICES[billing.invoice_tier || 'standard'].display} 🎉💰`);
          }
          changed++;
        }
      }
      if (billing.sub_session_id && billing.sub_status === 'pending') {
        const st = await checkoutStatus(env.STRIPE_SECRET_KEY, billing.sub_session_id);
        if (st.complete) {
          billing.sub_status = 'active'; billing.subscription_id = st.subscription;
          await logEvent(db, client.id, 'hosting_active', 'Hosting & security $49/mo ACTIVE 🔒✅');
          changed++;
        }
      }
      if (changed) await touchClient(db, client.id, { billing: JSON.stringify(billing) });
    } catch { /* keep polling others */ }
  }
  return changed;
}

// Manual bypass: mark paid / hosting active when handled outside Stripe (cash, Venmo, comp)
app.post('/api/clients/:id/billing-bypass', async (c) => {
  const id = Number(c.req.param('id'));
  const { what } = await c.req.json();
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'client not found' }, 404);
  const billing = getBilling(client);
  if (what === 'hosting') {
    billing.sub_status = 'active'; billing.sub_bypass = true;
    await logEvent(db, id, 'hosting_active', 'Hosting marked ACTIVE manually (bypass — handled outside Stripe) 🔓');
  } else {
    billing.invoice_status = 'paid'; billing.invoice_bypass = true; billing.paid_at = new Date().toISOString();
    await logEvent(db, id, 'invoice_paid', 'Invoice marked PAID manually (bypass — paid outside Stripe) 🔓💰');
  }
  await touchClient(db, id, { billing: JSON.stringify(billing) });
  return c.json({ ok: true });
});

app.get('/api/clients/:id/score', async (c) => {
  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'client not found' }, 404);
  const settings = await getSettings(db);
  const score = await computeScore(db, client, settings);
  return c.json(score || { error: 'no site yet' });
});

app.post('/api/billing/poll', async (c) => {
  const n = await pollBilling(c.env);
  return c.json({ ok: true, changed: n });
});

// Free-text vibe → derived palette. Saves the brief; restyles the site if built.
app.post('/api/clients/:id/vibe', async (c) => {
  const id = Number(c.req.param('id'));
  const { vibe } = await c.req.json();
  if (!vibe || !String(vibe).trim()) return c.json({ error: 'describe the vibe first' }, 400);
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'client not found' }, 404);
  const { label, tokens } = vibeToTokens(vibe);
  await touchClient(db, id, { vibe: String(vibe).slice(0, 400), theme: '' });
  const metas = (await db.prepare(`SELECT slug, content FROM site_files WHERE path='site-meta.json'`).all()).results || [];
  let slug = null;
  for (const m of metas) { try { if (JSON.parse(m.content).client_id === id) { slug = m.slug; break; } } catch {} }
  if (!slug) {
    await logEvent(db, id, 'vibe_set', `Vibe brief saved: "${String(vibe).slice(0, 80)}" → ${label} 🎨 (applies at build)`);
    return c.json({ ok: true, applied: false, label });
  }
  const cssRow = await db.prepare(`SELECT content FROM site_files WHERE slug=? AND path='site.css'`).bind(slug).first();
  if (!cssRow) return c.json({ error: 'site.css not found' }, 404);
  let css = cssRow.content;
  for (const [k, v] of Object.entries(tokens)) {
    css = css.replace(new RegExp('(' + k.replace(/-/g, '\\-') + '\\s*:\\s*)#[0-9A-Fa-f]{3,8}'), '$1' + v);
  }
  if (!c.env.GITHUB_TOKEN) return c.json({ error: 'GITHUB_TOKEN not set' }, 500);
  const settings = await getSettings(db);
  const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
  const path = `sites/${slug}/site.css`;
  const ghHeaders = { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' };
  const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, { headers: ghHeaders });
  const existing = getRes.ok ? await getRes.json() : null;
  const b64 = btoa(unescape(encodeURIComponent(css)));
  const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'PUT', headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Vibe: "${String(vibe).slice(0, 50)}" → ${slug}`, content: b64, ...(existing?.sha ? { sha: existing.sha } : {}) }),
  });
  if (!putRes.ok) return c.json({ error: `GitHub commit failed: ${putRes.status}` }, 502);
  await db.prepare(`UPDATE site_files SET content=?, updated_at=datetime('now') WHERE slug=? AND path='site.css'`).bind(css, slug).run();
  await logEvent(db, id, 'vibe_set', `Vibe applied: "${String(vibe).slice(0, 60)}" → ${label} 🎨`);
  return c.json({ ok: true, applied: true, label });
});

// Client logo: upload (stores master copy; also pushes into the client's site if built)
app.post('/api/clients/:id/logo', async (c) => {
  const id = Number(c.req.param('id'));
  const { b64, ext = 'png' } = await c.req.json();
  if (!b64) return c.json({ error: 'b64 required' }, 400);
  const safeExt = ['png', 'jpg', 'webp'].includes(ext) ? ext : 'png';
  const mime = safeExt === 'webp' ? 'image/webp' : safeExt === 'jpg' ? 'image/jpeg' : 'image/png';
  const clean = b64.replace(/^data:[^,]+,/, '');
  if (clean.length > 2_600_000) return c.json({ error: 'logo too large — keep it under ~1.8MB' }, 400);
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'client not found' }, 404);
  // master copy (slug outside sites/ namespace, never published)
  await db.prepare(`INSERT INTO site_files (slug, path, content, content_type, is_base64, updated_at)
    VALUES (?, 'logo', ?, ?, 1, datetime('now'))
    ON CONFLICT(slug, path) DO UPDATE SET content=excluded.content, content_type=excluded.content_type, updated_at=datetime('now')`)
    .bind(`_assets-${id}`, clean, mime).run();
  // if a site exists, push the logo into it (GitHub + D1) as img/logo.<ext>
  let applied = false;
  const metas = (await db.prepare(`SELECT slug, content FROM site_files WHERE path='site-meta.json'`).all()).results || [];
  let slug = null;
  for (const m of metas) { try { if (JSON.parse(m.content).client_id === id) { slug = m.slug; break; } } catch {} }
  if (slug && c.env.GITHUB_TOKEN) {
    const settings = await getSettings(db);
    const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
    const path = `sites/${slug}/img/logo.${safeExt}`;
    const ghHeaders = { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' };
    const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, { headers: ghHeaders });
    const existing = getRes.ok ? await getRes.json() : null;
    const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      method: 'PUT', headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Client logo → ${slug}`, content: clean, ...(existing?.sha ? { sha: existing.sha } : {}) }),
    });
    if (putRes.ok) {
      await db.prepare(`INSERT INTO site_files (slug, path, content, content_type, is_base64, updated_at)
        VALUES (?, ?, ?, ?, 1, datetime('now'))
        ON CONFLICT(slug, path) DO UPDATE SET content=excluded.content, content_type=excluded.content_type, updated_at=datetime('now')`)
        .bind(slug, `img/logo.${safeExt}`, clean, mime).run();
      applied = true;
    }
  }
  await logEvent(db, id, 'logo_uploaded', applied ? 'Logo uploaded and pushed to the live site 🖼' : 'Logo uploaded 🖼 (will be used at build time)');
  return c.json({ ok: true, applied });
});

// Client photos: up to 6, same pattern as logo (master copy + push into built site)
app.post('/api/clients/:id/photo', async (c) => {
  const id = Number(c.req.param('id'));
  const { b64, ext = 'jpg', n = 1 } = await c.req.json();
  if (!b64) return c.json({ error: 'b64 required' }, 400);
  const slot = Math.min(6, Math.max(1, Number(n) || 1));
  const safeExt = ['png', 'jpg', 'webp'].includes(ext) ? ext : 'jpg';
  const mime = safeExt === 'webp' ? 'image/webp' : safeExt === 'png' ? 'image/png' : 'image/jpeg';
  const clean = b64.replace(/^data:[^,]+,/, '');
  if (clean.length > 4_000_000) return c.json({ error: 'photo too large — keep under ~3MB' }, 400);
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'client not found' }, 404);
  await db.prepare(`INSERT INTO site_files (slug, path, content, content_type, is_base64, updated_at)
    VALUES (?, ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(slug, path) DO UPDATE SET content=excluded.content, content_type=excluded.content_type, updated_at=datetime('now')`)
    .bind(`_assets-${id}`, `photo-${slot}`, clean, mime).run();
  let applied = false;
  const metas = (await db.prepare(`SELECT slug, content FROM site_files WHERE path='site-meta.json'`).all()).results || [];
  let slug = null;
  for (const m of metas) { try { if (JSON.parse(m.content).client_id === id) { slug = m.slug; break; } } catch {} }
  if (slug && c.env.GITHUB_TOKEN) {
    const settings = await getSettings(db);
    const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
    const path = `sites/${slug}/img/client-photo-${slot}.${safeExt}`;
    const ghHeaders = { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' };
    const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, { headers: ghHeaders });
    const existing = getRes.ok ? await getRes.json() : null;
    const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      method: 'PUT', headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Client photo ${slot} → ${slug}`, content: clean, ...(existing?.sha ? { sha: existing.sha } : {}) }),
    });
    if (putRes.ok) {
      await db.prepare(`INSERT INTO site_files (slug, path, content, content_type, is_base64, updated_at)
        VALUES (?, ?, ?, ?, 1, datetime('now'))
        ON CONFLICT(slug, path) DO UPDATE SET content=excluded.content, content_type=excluded.content_type, updated_at=datetime('now')`)
        .bind(slug, `img/client-photo-${slot}.${safeExt}`, clean, mime).run();
      applied = true;
    }
  }
  await logEvent(db, id, 'photo_uploaded', `Client photo ${slot} uploaded 📷${applied ? ' — available on the live site' : ' (used at build time)'}`);
  return c.json({ ok: true, slot, applied });
});

app.get('/api/clients/:id/photo/:n', async (c) => {
  const row = await c.env.DB.prepare(`SELECT content, content_type FROM site_files WHERE slug=? AND path=?`)
    .bind(`_assets-${Number(c.req.param('id'))}`, `photo-${Math.min(6, Math.max(1, Number(c.req.param('n')) || 1))}`).first();
  if (!row) return c.text('no photo', 404);
  const bytes = Uint8Array.from(atob(row.content), (ch) => ch.charCodeAt(0));
  return c.body(bytes, 200, { 'Content-Type': row.content_type, 'Cache-Control': 'no-store' });
});

// Serve the stored logo for the dashboard preview
app.get('/api/clients/:id/logo', async (c) => {
  const row = await c.env.DB.prepare(`SELECT content, content_type FROM site_files WHERE slug=? AND path='logo'`)
    .bind(`_assets-${Number(c.req.param('id'))}`).first();
  if (!row) return c.text('no logo', 404);
  const bytes = Uint8Array.from(atob(row.content), (ch) => ch.charCodeAt(0));
  return c.body(bytes, 200, { 'Content-Type': row.content_type, 'Cache-Control': 'no-store' });
});

// Apply a preset theme to a client's site: rewrites design tokens in site.css,
// commits to GitHub and updates D1 so the preview restyles immediately.
app.post('/api/clients/:id/theme', async (c) => {
  const id = Number(c.req.param('id'));
  const { theme } = await c.req.json();
  const t = THEMES[theme];
  if (!t) return c.json({ error: 'unknown theme' }, 400);
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'client not found' }, 404);
  // always remember the choice — the site generator uses it at build time
  await touchClient(db, id, { theme });
  const metas = (await db.prepare(`SELECT slug, content FROM site_files WHERE path='site-meta.json'`).all()).results || [];
  let slug = null;
  for (const m of metas) { try { if (JSON.parse(m.content).client_id === id) { slug = m.slug; break; } } catch {} }
  if (!slug) {
    await logEvent(db, id, 'theme_changed', `Theme preselected: ${t.label} 🎨 (will style the site at build time)`);
    return c.json({ ok: true, saved: true, applied: false, theme, label: t.label });
  }
  const cssRow = await db.prepare(`SELECT content FROM site_files WHERE slug=? AND path='site.css'`).bind(slug).first();
  if (!cssRow) return c.json({ error: 'site.css not found' }, 404);
  let css = cssRow.content;
  for (const [k, v] of Object.entries(t.tokens)) {
    css = css.replace(new RegExp('(' + k.replace(/-/g, '\\-') + '\\s*:\\s*)#[0-9A-Fa-f]{3,8}'), '$1' + v);
  }
  if (!c.env.GITHUB_TOKEN) return c.json({ error: 'GITHUB_TOKEN not set' }, 500);
  const settings = await getSettings(db);
  const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
  const path = `sites/${slug}/site.css`;
  const ghHeaders = { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' };
  const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, { headers: ghHeaders });
  const existing = getRes.ok ? await getRes.json() : null;
  const b64 = btoa(unescape(encodeURIComponent(css)));
  const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Theme: ${t.label} → ${slug}`, content: b64, ...(existing?.sha ? { sha: existing.sha } : {}) }),
  });
  if (!putRes.ok) return c.json({ error: `GitHub commit failed: ${putRes.status}` }, 502);
  await db.prepare(`UPDATE site_files SET content=?, updated_at=datetime('now') WHERE slug=? AND path='site.css'`).bind(css, slug).run();
  await logEvent(db, id, 'theme_changed', `Theme set to ${t.label} 🎨`);
  return c.json({ ok: true, saved: true, applied: true, slug, theme, label: t.label });
});

// ---------------- API: settings & GHL utilities ----------------
app.post('/api/settings', async (c) => {
  const body = await c.req.json();
  const allowed = [
    'ghl_location_id', 'form1_id', 'form2_id', 'form1_link', 'form2_link', 'email_from',
    'intake1_subject', 'intake1_body', 'intake2_subject', 'intake2_body',
    'booking_link', 'booking_subject', 'booking_body',
    'notify_email', 'sites_repo',
  ];
  for (const k of allowed) if (k in body) await setSetting(c.env.DB, k, body[k]);
  return c.json({ ok: true });
});

// Test GHL connection + list forms so Tiffany can pick which is which
app.get('/api/ghl/test', async (c) => {
  const settings = await getSettings(c.env.DB);
  if (!c.env.GHL_TOKEN) return c.json({ ok: false, error: 'GHL_TOKEN secret is not set on the worker.' });
  if (!settings.ghl_location_id) return c.json({ ok: false, error: 'No Location ID saved yet — add it in Settings.' });
  const ghl = ghlFor(c.env, settings);
  try {
    const [loc, sources] = await Promise.all([
      ghl.getLocation().catch((e) => ({ error: e.message })),
      ghl.listIntakeSources(),
    ]);
    return c.json({
      ok: true,
      location: loc?.location?.name || loc?.name || settings.ghl_location_id,
      forms: sources,
    });
  } catch (e) {
    return c.json({ ok: false, error: e.message });
  }
});

// Admin passthrough to the GHL API (session-protected) — used for setup/config tasks
app.post('/api/ghl/raw', async (c) => {
  const { method = 'GET', path, query, body } = await c.req.json();
  if (!path || !path.startsWith('/')) return c.json({ error: 'path required' }, 400);
  const settings = await getSettings(c.env.DB);
  const ghl = ghlFor(c.env, settings);
  try {
    const data = await ghl.req(method, path, { query, body });
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json({ ok: false, error: e.message, status: e.status, detail: e.data }, 200);
  }
});

// Cloudflare API passthrough (session-protected) — for infra automation
app.post('/api/cf/raw', async (c) => {
  const { method = 'GET', path, body } = await c.req.json();
  if (!path || !path.startsWith('/')) return c.json({ error: 'path required' }, 400);
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${c.env.CLOUDFLARE_API_TOKEN}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return c.json({ status: res.status, data });
});

// GitHub API passthrough (session-protected) — for repo automation
app.post('/api/gh/raw', async (c) => {
  if (!c.env.GITHUB_TOKEN) return c.json({ error: 'GITHUB_TOKEN secret not set' }, 400);
  const { method = 'GET', path, body } = await c.req.json();
  if (!path || !path.startsWith('/')) return c.json({ error: 'path required' }, 400);
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${c.env.GITHUB_TOKEN}`,
      'User-Agent': 'conversionco-mission-control',
      Accept: 'application/vnd.github+json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return c.json({ status: res.status, data });
});

// ---- site import machinery (shared by API endpoint + cron auto-publish) ----
const BASE_URL = 'https://conversionco-mission-control.conversionco918.workers.dev';

function ghFetcher(env) {
  return async function gh(path) {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'User-Agent': 'conversionco-mission-control',
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) throw new Error(`GitHub ${path} -> ${res.status}`);
    return res.json();
  };
}

async function importSite(env, settings, slug, clientId, treeFiles) {
  const db = env.DB;
  const gh = ghFetcher(env);
  const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
  let files = treeFiles;
  if (!files) {
    const ref = await gh(`/repos/${repo}/git/ref/heads/main`);
    const commit = await gh(`/repos/${repo}/git/commits/${ref.object.sha}`);
    const tree = await gh(`/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
    const prefix = `sites/${slug}/`;
    files = (tree.tree || []).filter((t) => t.type === 'blob' && t.path.startsWith(prefix));
  }
  if (!files.length) throw new Error(`No files for ${slug}`);
  const prefix = `sites/${slug}/`;
  let count = 0;
  for (const f of files) {
    const blob = await gh(`/repos/${repo}/git/blobs/${f.sha}`);
    const rel = f.path.slice(prefix.length);
    const ext = (rel.split('.').pop() || '').toLowerCase();
    const ctype = MIME[ext] || 'application/octet-stream';
    const isText = /^(text\/|application\/(javascript|json|xml))/.test(ctype) || ext === 'svg';
    const content = isText
      ? new TextDecoder().decode(Uint8Array.from(atob(blob.content.replace(/\n/g, '')), (ch) => ch.charCodeAt(0)))
      : blob.content.replace(/\n/g, '');
    await db.prepare(
      `INSERT INTO site_files (slug, path, content, content_type, is_base64, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(slug, path) DO UPDATE SET content=excluded.content, content_type=excluded.content_type,
       is_base64=excluded.is_base64, updated_at=datetime('now')`
    ).bind(slug, rel, content, ctype, isText ? 0 : 1).run();
    count++;
  }
  const previewUrl = `${BASE_URL}/preview/${slug}/`;
  if (clientId) {
    await touchClient(db, Number(clientId), { stage: 'preview_ready', preview_url: previewUrl });
    await logEvent(db, Number(clientId), 'preview_ready', previewUrl);
    if (settings.notify_email && settings.ghl_location_id) {
      try {
        const ghl = new GHL(env.GHL_TOKEN, settings.ghl_location_id);
        const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(Number(clientId)).first();
        const contact = await ghl.upsertContact({ email: settings.notify_email, name: 'ConversionCo Notifications' });
        await ghl.sendEmail({
          contactId: contact.id || contact.contactId,
          subject: `🎉 Website ready: ${client?.business_name || client?.name || slug}`,
          html: `<p>The site for <b>${client?.name || slug}</b> (${client?.email || ''}) is built and ready for your review.</p>
                 <p><a href="${previewUrl}">View the preview</a> &middot; <a href="${BASE_URL}">Open Mission Control</a></p>
                 <p>When you approve it, we connect the domain and go live.</p>`,
          emailFrom: settings.email_from || undefined,
        });
        await logEvent(db, Number(clientId), 'notified', `Notification sent to ${settings.notify_email}`);
      } catch (e) {
        await logEvent(db, Number(clientId), 'error', `Notify failed: ${e.message}`);
      }
    }
  }
  return { files: count, preview_url: previewUrl };
}

// Cron: auto-publish any new/updated site pushed to the client-sites repo
async function autoPublish(env, settings) {
  if (!env.GITHUB_TOKEN) return;
  const db = env.DB;
  const gh = ghFetcher(env);
  const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
  const ref = await gh(`/repos/${repo}/git/ref/heads/main`);
  const commit = await gh(`/repos/${repo}/git/commits/${ref.object.sha}`);
  const tree = await gh(`/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
  const blobs = (tree.tree || []).filter((t) => t.type === 'blob');
  const metas = blobs.filter((t) => /^sites\/[^/]+\/site-meta\.json$/.test(t.path));
  for (const m of metas) {
    const slug = m.path.split('/')[1];
    const seenKey = `site_sha_${slug}`;
    const seen = settings[seenKey];
    if (seen === m.sha) continue; // unchanged
    try {
      const metaBlob = await gh(`/repos/${repo}/git/blobs/${m.sha}`);
      const meta = JSON.parse(new TextDecoder().decode(
        Uint8Array.from(atob(metaBlob.content.replace(/\n/g, '')), (ch) => ch.charCodeAt(0))));
      const files = blobs.filter((t) => t.path.startsWith(`sites/${slug}/`));
      await importSite(env, settings, slug, meta.client_id, files);
      await setSetting(db, seenKey, m.sha);
      await logEvent(db, meta.client_id || null, 'auto_published', `${slug} auto-published from GitHub`);
    } catch (e) {
      await logEvent(db, null, 'error', `Auto-publish ${slug} failed: ${e.message}`);
    }
  }
}

// Manual import endpoint (session-protected)
app.post('/api/sites/import', async (c) => {
  const { slug, client_id } = await c.req.json();
  if (!slug) return c.json({ error: 'slug required' }, 400);
  if (!c.env.GITHUB_TOKEN) return c.json({ error: 'GITHUB_TOKEN secret not set' }, 400);
  const settings = await getSettings(c.env.DB);
  try {
    const r = await importSite(c.env, settings, slug, client_id);
    return c.json({ ok: true, ...r });
  } catch (e) {
    return c.json({ ok: false, error: e.message }, 502);
  }
});

// Test Cloudflare API token (used by the site-builder to publish client sites)
app.get('/api/cf/test', async (c) => {
  if (!c.env.CLOUDFLARE_API_TOKEN) return c.json({ ok: false, error: 'CLOUDFLARE_API_TOKEN secret is not set yet.' });
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/pages/projects`,
      { headers: { Authorization: `Bearer ${c.env.CLOUDFLARE_API_TOKEN}` } }
    );
    const data = await res.json();
    if (!data.success) return c.json({ ok: false, error: JSON.stringify(data.errors).slice(0, 300) });
    return c.json({ ok: true, projects: (data.result || []).map((p) => p.name) });
  } catch (e) {
    return c.json({ ok: false, error: e.message });
  }
});

app.post('/api/poll-now', async (c) => {
  const settings = await getSettings(c.env.DB);
  try {
    const result = await pollForms(c.env, settings);
    return c.json({ ok: true, ...result });
  } catch (e) {
    return c.json({ ok: false, error: e.message }, 502);
  }
});

// ---------------- form submission polling ----------------
function extractSubmissionFields(sub) {
  // GHL submissions put answers in `others` plus top-level name/email fields
  const out = {};
  const others = sub.others || {};
  for (const [k, v] of Object.entries(others)) {
    if (k.startsWith('__') || v === null || v === undefined) continue;
    out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  for (const k of ['name', 'email', 'phone']) if (sub[k]) out[k] = sub[k];
  return out;
}

async function pollForms(env, settings) {
  const db = env.DB;
  if (!settings.ghl_location_id) return { skipped: 'no location id' };
  const ghl = new GHL(env.GHL_TOKEN, settings.ghl_location_id);

  // look back 7 days so nothing is missed even after downtime
  const startAt = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const endAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);

  let processed = 0;
  for (const [formKey, dataCol, doneStage, minStages] of [
    ['form1_id', 'intake1_data', 'intake1_done', ['new', 'intake1_sent']],
    ['form2_id', 'intake2_data', 'intake2_done', ['new', 'intake1_sent', 'intake1_done', 'intake2_sent']],
  ]) {
    const formId = settings[formKey];
    if (!formId) continue;
    const subs = await ghl.intakeSubmissions(formId, { startAt, endAt });
    for (const sub of subs) {
      const email = (sub.email || sub.others?.email || '').trim();
      if (!email) continue;
      const fields = extractSubmissionFields(sub);
      const client = await db.prepare('SELECT * FROM clients WHERE email = ?').bind(email).first();
      if (!client) {
        // Someone found the form on their own — still capture them
        const r = await db.prepare(
          `INSERT INTO clients (email, name, phone, stage, ${dataCol}) VALUES (?, ?, ?, ?, ?)`
        ).bind(email, sub.name || '', sub.phone || '', doneStage, JSON.stringify(fields)).run();
        await logEvent(db, r.meta.last_row_id, doneStage, 'Form submitted (new contact, captured by poll)');
        processed++;
        continue;
      }
      const already = client[dataCol] && client[dataCol].length > 2;
      if (already) continue;
      const updates = { [dataCol]: JSON.stringify(fields) };
      if (sub.name && !client.name) updates.name = sub.name;
      if (sub.phone && !client.phone) updates.phone = sub.phone;
      if (minStages.includes(client.stage)) updates.stage = doneStage;
      await touchClient(db, client.id, updates);
      await logEvent(db, client.id, doneStage, 'Form submission received');
      processed++;
    }
  }
  await setSetting(db, 'last_poll_at', new Date().toISOString());
  return { processed };
}


// ---------------- daily uptime monitoring (runs on the daily cron) ----------------
async function dailyUptime(env) {
  const db = env.DB;
  const settings = await getSettings(db);
  const clients = (await db.prepare(`SELECT * FROM clients WHERE preview_url != '' OR live_url != ''`).all()).results || [];
  const results = [];
  for (const client of clients) {
    let up = false, how = '';
    if (client.live_url) {
      try {
        const r = await fetch(client.live_url, { method: 'GET', redirect: 'follow', cf: { cacheTtl: 0 } });
        up = r.ok; how = `live domain HTTP ${r.status}`;
      } catch (e) { up = false; how = `live domain unreachable (${String(e.message).slice(0, 60)})`; }
    } else {
      // preview-hosted: the worker itself serves it — verify the site files are intact in D1
      const metas = (await db.prepare(`SELECT slug, content FROM site_files WHERE path='site-meta.json'`).all()).results || [];
      let slug = null;
      for (const m of metas) { try { if (JSON.parse(m.content).client_id === client.id) { slug = m.slug; break; } } catch {} }
      if (slug) {
        const idx = await db.prepare(`SELECT length(content) AS n FROM site_files WHERE slug=? AND path='index.html'`).bind(slug).first();
        up = !!(idx && idx.n > 500); how = up ? 'preview serving from storage' : 'site files missing/corrupt';
      } else { up = true; how = 'no site yet (skipped)'; }
    }
    // rolling stats per client
    const key = `uptime_${client.id}`;
    let st = {}; try { st = JSON.parse(settings[key] || '{}'); } catch {}
    st.total = (st.total || 0) + 1;
    if (!up) st.fails = (st.fails || 0) + 1;
    st.last = up ? 'up' : 'down'; st.how = how; st.at = new Date().toISOString();
    await setSetting(db, key, JSON.stringify(st));
    results.push({ id: client.id, name: client.business_name || client.name || client.email, up, how });
    if (!up) {
      await logEvent(db, client.id, 'site_down', `⛔ SITE CHECK FAILED — ${how}`);
      if (settings.notify_email && settings.ghl_location_id && env.GHL_TOKEN) {
        try {
          const ghl = new GHL(env.GHL_TOKEN, settings.ghl_location_id);
          const contact = await ghl.upsertContact({ email: settings.notify_email, name: 'ConversionCo Notifications' });
          await ghl.sendEmail({
            contactId: contact.id || contact.contactId,
            subject: `⛔ Site check failed: ${client.business_name || client.name || client.email}`,
            html: `<p><b>${client.business_name || client.name || client.email}</b> failed today's automated site check.</p><p>${how}</p><p><a href="${BASE_URL}">Open Mission Control</a></p>`,
            emailFrom: settings.email_from || undefined,
          });
        } catch { /* alert email best-effort */ }
      }
    }
  }
  const downs = results.filter((r) => !r.up).length;
  await logEvent(db, null, 'uptime_check', `Daily site check: ${results.length - downs}/${results.length} up ✅${downs ? ` — ${downs} DOWN ⛔` : ''}`);
  return results;
}

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    await ensureSchema(env.DB);
    if (event.cron === '0 12 * * *') {
      ctx.waitUntil(dailyUptime(env).catch((e) =>
        logEvent(env.DB, null, 'error', `Uptime check failed: ${e.message}`)
      ));
      return;
    }
    const settings = await getSettings(env.DB);
    ctx.waitUntil(pollForms(env, settings).catch((e) =>
      logEvent(env.DB, null, 'error', `Poll failed: ${e.message}`)
    ));
    ctx.waitUntil(autoPublish(env, settings).catch((e) =>
      logEvent(env.DB, null, 'error', `Auto-publish failed: ${e.message}`)
    ));
    ctx.waitUntil(pollBilling(env).catch((e) =>
      logEvent(env.DB, null, 'error', `Billing poll failed: ${e.message}`)
    ));
  },
};
