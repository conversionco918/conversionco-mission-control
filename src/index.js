import { Hono } from 'hono';
import { GHL } from './ghl.js';
import { DEFAULT_TEMPLATES, BOOKING_TEMPLATES, DEFAULT_SETTINGS, renderTemplate } from './emails.js';
import { THEMES } from './themes.js';
import { vibeToTokens } from './vibe.js';
import { PRICES, ensureCustomer, sendInvoice, invoiceStatus, hostingCheckout, checkoutStatus, halfDisplay } from './stripe.js';

// 50/50 billing helpers (legacy full invoices from before the split still count)
function depositPaid(b) { return b.dep_status === 'paid' || b.invoice_status === 'paid'; }
function finalPaid(b) { return b.fin_status === 'paid' || b.invoice_status === 'paid'; }
import { computeScore } from './score.js';
import dashboardHtml from './ui.html';
import form1Html from './form1.html';
import form2Html from './form2.html';
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
  try { await db.prepare(`CREATE TABLE IF NOT EXISTS agreements (
    id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, version TEXT NOT NULL,
    package TEXT DEFAULT '', signed_name TEXT NOT NULL, signed_at TEXT NOT NULL DEFAULT (datetime('now')),
    user_agent TEXT DEFAULT '')`).run(); } catch {}
  try { await db.prepare(`CREATE TABLE IF NOT EXISTS revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL, request TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', note TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), done_at TEXT DEFAULT '')`).run(); } catch {}
  try { await db.prepare(`CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER, slug TEXT DEFAULT '',
    name TEXT DEFAULT '', email TEXT DEFAULT '', phone TEXT DEFAULT '', message TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`).run(); } catch {}
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
          await trySMS(ghl, db, clientId, contactId,
            `Hi ${firstName}! ConversionCo here — got your intake, thank you! Grab a time for your quick planning call: ${settings.booking_link}`);
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
      const rows = (await c.env.DB.prepare('SELECT id, email, business_name, tier, stage, billing FROM clients').all()).results || [];
      return rows.map((r) => {
        let b = {}; try { b = JSON.parse(r.billing || '{}'); } catch {}
        return { id: r.id, email: r.email, business_name: r.business_name, tier: r.tier, stage: r.stage,
          paid: depositPaid(b), paidInFull: finalPaid(b), hosting: b.sub_status === 'active' };
      });
    })(),
    revisionQueue: await (async () => {
      const rows = (await c.env.DB.prepare(`SELECT r.*, cl.business_name, cl.tier, cl.email FROM revisions r JOIN clients cl ON cl.id = r.client_id WHERE r.status = 'pending' ORDER BY r.id`).all()).results || [];
      return rows;
    })(),
    buildQueue: await (async () => {
      const rows = (await c.env.DB.prepare(`SELECT * FROM clients WHERE stage IN ('intake2_done','generating')`).all()).results || [];
      return rows.map((r) => {
        let b = {}; try { b = JSON.parse(r.billing || '{}'); } catch {}
        return { id: r.id, email: r.email, name: r.name, business_name: r.business_name,
          tier: r.tier || 'standard', theme: r.theme || '', vibe: r.vibe || '',
          paid: depositPaid(b),
          intake1: r.intake1_data || '', intake2: r.intake2_data || '' };
      });
    })(),
    counters: await (async () => {
      const rows = (await c.env.DB.prepare('SELECT id FROM clients').all()).results || [];
      const out = {};
      for (const r of rows) {
        const l = (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM leads WHERE client_id = ?').bind(r.id).first())?.n || 0;
        const v = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM revisions WHERE client_id = ? AND status='done'`).bind(r.id).first())?.n || 0;
        out[r.id] = { leads: l, revisionsDone: v };
      }
      return out;
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


// Revision runner callbacks (keyed; GET so headless sessions can call via WebFetch)
app.get('/api/revision-done/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const q = c.req.query();
  const id = Number(q.id);
  const status = q.status === 'failed' ? 'failed' : 'done';
  const rev = await c.env.DB.prepare('SELECT * FROM revisions WHERE id = ?').bind(id).first();
  if (!rev) return c.json({ ok: false, error: 'revision not found' });
  await c.env.DB.prepare(`UPDATE revisions SET status = ?, note = ?, done_at = datetime('now') WHERE id = ?`)
    .bind(status, String(q.note || '').slice(0, 400), id).run();
  await logEvent(c.env.DB, rev.client_id, status === 'done' ? 'revision_done' : 'revision_failed',
    `${status === 'done' ? '✅ Revision applied' : '⚠️ Revision needs attention'}: "${rev.request.slice(0, 80)}"${q.note ? ' — ' + String(q.note).slice(0, 120) : ''}`);
  return c.json({ ok: true });
});

// Keyed setter for the sending identity (email_from) — used during deliverability setup
app.get('/api/set-from/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const value = String(c.req.query('value') || '').trim();
  if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return c.json({ ok: false, error: 'invalid email' });
  await c.env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('email_from', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(value).run();
  return c.json({ ok: true, email_from: value });
});

// Keyed: trace what GHL/Mailgun actually did with emails to an address (delivery status)
app.get('/api/email-status/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const email = String(c.req.query('email') || '').trim();
  if (!email) return c.json({ ok: false, error: '?email= required' });
  const settings = await getSettings(c.env.DB);
  const ghl = new GHL(c.env.GHL_TOKEN, settings.ghl_location_id);
  try {
    const contact = await ghl.upsertContact({ email });
    const contactId = contact.id || contact.contactId;
    const conv = await ghl.req('GET', '/conversations/search', { query: { locationId: settings.ghl_location_id, contactId, limit: 5 } });
    const convs = conv.conversations || [];
    const out = [];
    for (const cv of convs) {
      try {
        const msgs = await ghl.req('GET', `/conversations/${cv.id}/messages`, { query: { limit: 20 } });
        const list = msgs.messages?.messages || msgs.messages || [];
        for (const m of list) {
          if (String(m.messageType || m.type || '').toLowerCase().includes('email') || m.type === 3) {
            const entry = { dateAdded: m.dateAdded, status: m.status, source: m.source, direction: m.direction, meta: m.meta?.email || undefined, id: m.id };
            const mids = m.meta?.email?.messageIds || [];
            entry.detail = [];
            for (const mid of mids.slice(0, 3)) {
              try {
                const d = await ghl.req('GET', `/conversations/messages/email/${mid}`);
                const e2 = d.emailMessage || d;
                entry.detail.push({ status: e2.status, subject: e2.subject, from: e2.from, to: e2.to, error: e2.error || e2.failureReason || undefined, dateAdded: e2.dateAdded });
              } catch (e) { entry.detail.push({ detailError: String(e.message).slice(0, 200) }); }
            }
            out.push(entry);
          }
        }
      } catch (e) { out.push({ convError: String(e.message).slice(0, 200) }); }
    }
    return c.json({ ok: true, email, contactId, conversations: convs.length, emails: out });
  } catch (e) { return c.json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
});

// Keyed: the auto-builder calls this the moment it starts building a client's site,
// so Mission Control shows "⚙ Building site…" live instead of jumping straight to preview.
app.get('/api/build-started/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const id = Number(c.req.query('id'));
  if (!id) return c.json({ ok: false, error: '?id= required' });
  const client = await c.env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ ok: false, error: 'client not found' });
  await touchClient(c.env.DB, id, { stage: 'generating' });
  await setSetting(c.env.DB, `buildprog_${id}`, JSON.stringify({ started_at: new Date().toISOString(), pct: 5, step: 'Build started' }));
  await logEvent(c.env.DB, id, 'build_started', `⚙ Build started for ${client.business_name || client.name || client.email} — site is being generated now`);
  return c.json({ ok: true });
});

// Keyed: the builder reports milestones so the dashboard progress bar is real
app.get('/api/build-progress/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const id = Number(c.req.query('id'));
  const pct = Math.max(1, Math.min(99, Number(c.req.query('pct')) || 0));
  const step = String(c.req.query('step') || '').slice(0, 60);
  if (!id || !pct) return c.json({ ok: false, error: '?id= and ?pct= required' });
  const settings = await getSettings(c.env.DB);
  let prog = {}; try { prog = JSON.parse(settings[`buildprog_${id}`] || '{}'); } catch {}
  if (!prog.started_at) prog.started_at = new Date().toISOString();
  prog.pct = Math.max(prog.pct || 0, pct); // never move backwards
  if (step) prog.step = step;
  prog.updated_at = new Date().toISOString();
  await setSetting(c.env.DB, `buildprog_${id}`, JSON.stringify(prog));
  return c.json({ ok: true, ...prog });
});

// Keyed: resend the agreement invite (same email the card button sends)
app.get('/api/send-agreement/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const id = Number(c.req.query('id'));
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client || !client.email) return c.json({ ok: false, error: 'client/email missing' });
  const settings = await getSettings(db);
  if (!c.env.GHL_TOKEN || !settings.ghl_location_id) return c.json({ ok: false, error: 'GHL not configured' });
  const url = `${BASE_URL}/agreement/${id}/${await portalToken(c.env, 'agr', id)}`;
  const biz = client.business_name || client.name || 'your business';
  try {
    const ghl = ghlFor(c.env, settings);
    const contact = await ghl.upsertContact({ email: client.email, name: client.name || '' });
    await ghl.sendEmail({ contactId: contact.id || contact.contactId,
      subject: `One quick signature before we begin — ${biz}`,
      html: `<p>Hi ${(client.name || '').split(' ')[0] || 'there'},</p>
<p>We're excited to build this with you. Before your invoice, here's our service agreement — plain English, about two minutes to read, and it protects both of us. The short version: your domain and your website are yours, and it spells out exactly what our service covers:</p>
<p><a href="${url}">${url}</a></p>
<p>Your invoice follows right after you sign. Questions about anything in it? Just reply — happy to walk you through.</p>
<p>Talk soon,<br>The ConversionCo Team</p>`,
      emailFrom: settings.email_from || undefined });
    let billing = {}; try { billing = JSON.parse(client.billing || '{}'); } catch {}
    billing.agr_sent = new Date().toISOString();
    await touchClient(db, id, { billing: JSON.stringify(billing) });
    await logEvent(db, id, 'agreement_sent', `📄 Agreement re-sent to ${client.email}`);
    return c.json({ ok: true });
  } catch (e) { return c.json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
});

// Keyed: clear stored email-template overrides so the code defaults (personal style) apply
app.get('/api/reset-templates/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const keys = ['intake1_subject', 'intake1_body', 'intake2_subject', 'intake2_body', 'booking_subject', 'booking_body'];
  for (const k of keys) await c.env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(k).run();
  return c.json({ ok: true, cleared: keys });
});

// Keyed: fire the weekly owner digest on demand (testing / catch-up)
app.get('/api/digest-now/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  await weeklyOwnerDigest(c.env);
  return c.json({ ok: true });
});

// Deliverability test (keyed): sends a styled test email so inbox placement can be verified
app.get('/api/test-email/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const to = String(c.req.query('to') || '').trim();
  if (!/.+@.+\..+/.test(to)) return c.json({ ok: false, error: 'valid ?to= required' });
  const settings = await getSettings(c.env.DB);
  if (!c.env.GHL_TOKEN || !settings.ghl_location_id) return c.json({ ok: false, error: 'GHL not configured' });
  const stamp = String(c.req.query('stamp') || Date.now());
  const link = `${BASE_URL}/portfolio.json`;
  try {
    const ghl = new GHL(c.env.GHL_TOKEN, settings.ghl_location_id);
    const contact = await ghl.upsertContact({ email: to, name: 'Deliverability Test' });
    await ghl.sendEmail({
      contactId: contact.id || contact.contactId,
      subject: `Quick test from ConversionCo (${stamp.slice(-6)})`,
      html: `<p>Hi there,</p>
<p>This is a quick delivery test from the ConversionCo system. If you're reading this in your inbox, everything is working exactly as it should. Here's a test link to tap:</p>
<p><a href="${link}">${link}</a></p>
<p>Talk soon,<br>The ConversionCo Team</p>`,
      emailFrom: settings.email_from || undefined,
    });
    return c.json({ ok: true, to, stamp });
  } catch (e) { return c.json({ ok: false, error: String(e.message || e) }); }
});

// Self-hosted intake forms (mobile-bulletproof — no funnel builder in the path)
app.get('/form/1', (c) => c.html(form1Html));
app.get('/form/2', (c) => c.html(form2Html));

// ---------------- service agreement (sent before payment, e-signed) ----------------
const AGREEMENT_VERSION = 'v2-2026-07-23-split';
function agreementTerms(biz, pkgLabel, pkgPrice) {
  return [
    ['1. What we are building', `ConversionCo will design, write, and build the ${pkgLabel} for ${biz}: a custom, mobile-first website with full search-engine setup as described in your proposal. Your one-time project fee is ${pkgPrice}, paid in two equal halves: 50% as a deposit before the build begins, and the remaining 50% when your finished website preview is delivered to you.`],
    ['2. Website Care Plan — $49/month', `Keeping your website live with us is covered by the Website Care Plan: hosting, security, daily uptime monitoring, performance reports, and ongoing platform updates (Premium plans also include weekly published content). It is month-to-month, starts only when your site is ready and you confirm, and you may cancel any time — cancellation takes effect at the end of the current billing period.`],
    ['3. Payment & refunds', `The build starts once your 50% deposit is received. Because our build process begins immediately and produces custom work, the deposit is non-refundable once your build has started — with one exception in your favor: if we fail to deliver a preview of your website within 14 days of your deposit, you may request a full refund of it. The remaining 50% is invoiced when your website preview is delivered, and is due within 7 days. Your website goes live on your domain once the balance is paid.`],
    ['4. Revisions', `Your project includes two full rounds of revisions before launch, plus reasonable adjustments during your first 30 days live. After that, changes are handled through your Care Plan (reasonable monthly volume) or quoted separately for larger redesigns. This keeps every project fair — for you and for our other clients.`],
    ['5. What you own', `Your domain name is yours — registered for your business, and transferable to your direct control on request at any time. Your content is yours — your logo, photos, story, and business information. And once your project fee is paid in full, the finished website code (the HTML, CSS, JavaScript, and images that make up your site) is yours as well.`],
    ['6. What remains ours', `The ConversionCo platform is licensed to you while you are a client, and is never transferred: our client portal and dashboards, our automated build, content, and reporting systems, our monitoring tools, and our internal processes. These power your service; they are not part of the website deliverable.`],
    ['7. If you ever leave', `You can leave whenever you want — no lock-in. On cancellation we provide a complete export of your website code and assist in pointing your domain wherever you direct. What ends with the service: hosting, the client portal, monitoring, reports, and future content or updates. Your website files are yours to host anywhere.`],
    ['8. Your content & your practice', `You confirm that materials you provide (photos, logo, reviews, text) are yours to use. You remain solely responsible for the clinical and legal operation of your practice, including licensure, protocols, and advertising compliance. We build health-content-compliant websites and may decline content that violates Google or health-advertising policies — that protection benefits us both.`],
    ['9. Portfolio', `We may display the finished website in the ConversionCo portfolio and marketing materials. If you prefer we do not, tell us in writing and we will remove it.`],
    ['10. Reasonable limits', `We target excellent uptime and monitor your site daily, but no provider can guarantee against third-party outages. Each party's total liability under this agreement is capped at the fees paid in the six months prior to a claim, and neither party is liable for indirect or consequential damages.`],
    ['11. Non-payment', `If a Care Plan payment is more than 15 days late, we may pause the website until the account is current — we will always reach out first.`],
    ['12. The basics', `ConversionCo is an independent contractor. This is the entire agreement between us, governed by Oklahoma law; changes must be in writing (email counts). If any part is unenforceable, the rest stands.`],
  ];
}
app.get('/agreement/:id/:token', async (c) => {
  const id = Number(c.req.param('id'));
  if (c.req.param('token') !== await portalToken(c.env, 'agr', id)) return c.text('not found', 404);
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.text('not found', 404);
  const signed = await db.prepare('SELECT * FROM agreements WHERE client_id = ? ORDER BY id DESC LIMIT 1').bind(id).first();
  const biz = client.business_name || client.name || 'your business';
  const pkgLabel = client.tier === 'premium' ? 'Premium Website + SEO Engine' : 'Standard Website Package';
  const pkgPrice = client.tier === 'premium' ? '$999' : '$649';
  const terms = agreementTerms(biz, pkgLabel, pkgPrice);
  const tok = c.req.param('token');
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Service Agreement — ${biz} × ConversionCo</title>
<style>
  *{box-sizing:border-box;margin:0}body{font-family:-apple-system,'Segoe UI',sans-serif;background:linear-gradient(170deg,#0C1A30,#0F2847);color:#1A2433;line-height:1.65;padding:30px 14px 60px}
  .card{max-width:680px;margin:0 auto;background:#fff;border-radius:16px;padding:30px 26px;box-shadow:0 20px 60px rgba(0,0,0,.35)}
  .eyebrow{color:#C9A254;font-size:11px;letter-spacing:.24em;font-weight:700;text-align:center}
  h1{font-size:24px;text-align:center;margin:8px 0 4px;color:#0C1A30}
  .sub{text-align:center;color:#667;font-size:13.5px;margin-bottom:24px}
  h2{font-size:15px;color:#0C1A30;margin:20px 0 6px}
  p{font-size:14px;color:#3A4557}
  .sig{border-top:2px solid #EEF1F5;margin-top:28px;padding-top:22px}
  label{display:flex;gap:10px;font-size:14px;align-items:flex-start;margin-bottom:14px;cursor:pointer}
  input[type=text]{width:100%;padding:13px 14px;border:1.5px solid #D6DCE5;border-radius:10px;font-size:16px;margin-bottom:14px;font-family:inherit}
  button{width:100%;padding:15px;border:0;border-radius:10px;background:#C9A254;color:#0C1A30;font-size:16px;font-weight:700;cursor:pointer}
  .ok{background:#ECFDF5;border:1px solid #A7F3D0;color:#047857;border-radius:12px;padding:18px;text-align:center;font-weight:600}
  .meta{font-size:11.5px;color:#99A3B0;text-align:center;margin-top:18px}
</style></head><body>
<div class="card">
  <div class="eyebrow">CONVERSION CO</div>
  <h1>Website Service Agreement</h1>
  <p class="sub">Between <b>ConversionCo</b> and <b>${biz}</b> · ${pkgLabel} · ${pkgPrice} + $49/mo Care Plan at launch</p>
  ${terms.map(([h, t]) => `<h2>${h}</h2><p>${t}</p>`).join('')}
  <div class="sig">
  ${signed ? `<div class="ok">✓ Signed by ${signed.signed_name} on ${signed.signed_at} UTC</div>` : `
    <form id="agr">
      <label><input type="checkbox" id="agree" required style="margin-top:3px"> I have read this agreement and I agree to its terms on behalf of ${biz}.</label>
      <input type="text" id="signName" required placeholder="Type your full legal name to sign">
      <button type="submit">Sign Agreement ✍️</button>
      <p id="agrOk" style="display:none" class="ok">✓ Signed — thank you! Your invoice is on its way.</p>
    </form>`}
  </div>
  <p class="meta">Agreement ${AGREEMENT_VERSION} · A signed copy is emailed to both parties and kept on file.</p>
</div>
${signed ? '' : `<script>
document.getElementById('agr').addEventListener('submit', async (e) => {
  e.preventDefault();
  const n = document.getElementById('signName').value.trim();
  if (!document.getElementById('agree').checked || !n) return;
  await fetch('/agreement-sign/${id}/${tok}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n }) });
  e.target.querySelector('button').style.display = 'none';
  document.getElementById('agrOk').style.display = 'block';
});
</script>`}
</body></html>`);
});
app.post('/agreement-sign/:id/:token', async (c) => {
  const id = Number(c.req.param('id'));
  if (c.req.param('token') !== await portalToken(c.env, 'agr', id)) return c.text('nope', 403);
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'not found' }, 404);
  let f = {}; try { f = await c.req.json(); } catch {}
  const name = String(f.name || '').slice(0, 120).trim();
  if (!name) return c.json({ error: 'name required' }, 400);
  const pkg = client.tier === 'premium' ? 'Premium $999' : 'Standard $649';
  await db.prepare('INSERT INTO agreements (client_id, version, package, signed_name, user_agent) VALUES (?, ?, ?, ?, ?)')
    .bind(id, AGREEMENT_VERSION, pkg, name, (c.req.header('User-Agent') || '').slice(0, 200)).run();
  await logEvent(db, id, 'agreement_signed', `✍️ Agreement signed by ${name} (${pkg})`);
  const settings = await getSettings(db);
  if (c.env.GHL_TOKEN && settings.ghl_location_id) {
    const url = `${BASE_URL}/agreement/${id}/${await portalToken(c.env, 'agr', id)}`;
    try {
      const ghl = ghlFor(c.env, settings);
      // copy to client
      const contact = await ghl.upsertContact({ email: client.email, name: client.name || '' });
      await ghl.sendEmail({ contactId: contact.id || contact.contactId,
        subject: `Your signed agreement with ConversionCo`,
        html: `<p>Hi ${(client.name || '').split(' ')[0] || 'there'},</p><p>Thanks — your service agreement is signed and on file. You can view it any time here:</p><p><a href="${url}">${url}</a></p><p>Next up: your invoice. Once that's settled, the build begins. Questions any time — just reply.</p><p>Talk soon,<br>The ConversionCo Team</p>`,
        emailFrom: settings.email_from || undefined });
      // copy to Tiffany
      const me = await ghl.upsertContact({ email: settings.notify_email, name: 'ConversionCo Notifications' });
      await ghl.sendEmail({ contactId: me.id || me.contactId,
        subject: `✍️ ${client.business_name || client.name || client.email} signed the agreement`,
        html: `<p><b>${name}</b> signed (${pkg}).</p><p><a href="${url}">View agreement</a> · <a href="${BASE_URL}">Open Mission Control</a> — time to send the invoice.</p>`,
        emailFrom: settings.email_from || undefined });
    } catch {}
  }
  return c.json({ ok: true });
});

// ---------------- public: client portal, pitch pages, lead capture ----------------
async function portalToken(env, kind, id) {
  const t = await hmac(env.SESSION_SECRET, `${kind}:${id}`);
  return t.replace(/[+/=]/g, '').slice(0, 16);
}
async function slugForClient(db, id) {
  const metas = (await db.prepare(`SELECT slug, content FROM site_files WHERE path='site-meta.json'`).all()).results || [];
  for (const m of metas) { try { if (JSON.parse(m.content).client_id === id) return m.slug; } catch {} }
  return null;
}
const PORTAL_STAGES = [
  ['intake1_sent', 'Getting to know you'], ['intake1_done', 'Blueprint received'],
  ['intake2_done', 'Vision captured'], ['generating', 'Designing & building'],
  ['preview_ready', 'Preview ready'], ['live', 'LIVE on the web'],
];
app.get('/portal/:id/:token', async (c) => {
  const id = Number(c.req.param('id'));
  if (c.req.param('token') !== await portalToken(c.env, 'portal', id)) return c.text('not found', 404);
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.text('not found', 404);
  const settings = await getSettings(db);
  const score = await computeScore(db, client, settings);
  let up = null; try { up = JSON.parse(settings[`uptime_${id}`] || 'null'); } catch {}
  let billing = {}; try { billing = JSON.parse(client.billing || '{}'); } catch {}
  const slug = await slugForClient(db, id);
  const blogs = slug ? ((await db.prepare(`SELECT path FROM site_files WHERE slug=? AND path LIKE 'blog-%' ORDER BY updated_at DESC LIMIT 5`).bind(slug).all()).results || []) : [];
  const leadsN = (await db.prepare('SELECT COUNT(*) AS n FROM leads WHERE client_id = ?').bind(id).first())?.n || 0;
  const revsN = (await db.prepare(`SELECT COUNT(*) AS n FROM revisions WHERE client_id = ? AND status = 'done'`).bind(id).first())?.n || 0;
  const FRIENDLY = { auto_published: '🚀 Website updated & republished', revision_done: '✅ A requested change was completed',
    theme_changed: '🎨 Fresh look applied to your site', logo_uploaded: '🖼 Your logo was added', photo_uploaded: '📷 New photo added to your site',
    lead_received: '🔥 New lead captured from your website', preview_ready: '👀 A new version was published', hosting_active: '🛡 Hosting & security activated',
    build_started: '⚙️ Your website build is underway', invoice_paid: '💳 Payment received — thank you!' };
  const evRows = (await db.prepare(`SELECT type, created_at FROM events WHERE client_id = ? AND type IN ('auto_published','revision_done','theme_changed','logo_uploaded','photo_uploaded','lead_received','preview_ready','hosting_active','build_started','invoice_paid') ORDER BY id DESC LIMIT 8`).bind(id).all()).results || [];
  // reports list from GitHub (best effort)
  let reports = [];
  if (slug && c.env.GITHUB_TOKEN) {
    try {
      const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
      const r = await fetch(`https://api.github.com/repos/${repo}/contents/reports/${slug}`, {
        headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' } });
      if (r.ok) reports = (await r.json()).filter((f) => f.name.endsWith('.html')).map((f) => f.name).sort().reverse().slice(0, 6);
    } catch {}
  }
  const biz = client.business_name || client.name || 'Your Business';
  const stageIdx = PORTAL_STAGES.findIndex(([k]) => k === client.stage);
  const doneIdx = stageIdx === -1 ? (client.stage === 'intake2_sent' ? 2 : 0) : stageIdx;
  const siteUrl = client.live_url || client.preview_url || '';
  const upPct = up && up.total ? Math.round(100 * (up.total - (up.fails || 0)) / up.total) : null;
  const tok = c.req.param('token');
  const isPremium = client.tier === 'premium';
  const bars = score ? Object.entries(score.breakdown).map(([k, v]) =>
    `<div class="bar"><span>${k === 'offsite' ? 'off-site' : k}</span><div class="tr"><div class="fl" style="width:${Math.round(100 * v.score / v.max)}%"></div></div><b>${v.score}/${v.max}</b></div>`).join('') : '';
  const plan = isPremium
    ? ['Custom luxury website — every page designed for you', 'A landing page for every drip (Google loves depth)', 'City pages for local search domination', 'A new SEO article written & published every week', 'Weekly performance report with your SEO Score', 'Daily uptime & security monitoring', 'Review funnel — happy clients routed to Google']
    : ['Custom luxury website — every page designed for you', 'Full search-engine foundation (schema, sitemap, local targeting)', 'Monthly performance report with your SEO Score', 'Daily uptime & security monitoring', 'Booking built into every page'];
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${biz} — Client Portal | ConversionCo</title>
<style>
  *{box-sizing:border-box;margin:0}body{font-family:-apple-system,'Segoe UI',sans-serif;background:#0B1D33;color:#EDF2F7;line-height:1.6}
  .wrap{max-width:780px;margin:0 auto;padding:40px 20px 80px}
  .head{display:flex;align-items:center;gap:14px;margin-bottom:6px}
  .head img{height:44px;max-width:130px;object-fit:contain;background:#fff;border-radius:10px;padding:4px}
  h1{font-size:26px}.sub{color:#8EA3BC;font-size:13px;margin-bottom:30px}
  .card{background:#10263F;border:1px solid #1E3A5C;border-radius:16px;padding:24px;margin-bottom:18px}
  .card h2{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#C9A254;margin-bottom:16px}
  .steps{display:flex;flex-direction:column;gap:10px}
  .step{display:flex;gap:12px;align-items:center;font-size:15px}
  .dot{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-size:13px;flex:0 0 26px;background:#1E3A5C;color:#8EA3BC}
  .done .dot{background:#059669;color:#fff}.now .dot{background:#C9A254;color:#0B1D33}
  .now{font-weight:600}.pend{color:#5C7794}
  .scorebig{display:flex;gap:26px;align-items:center;flex-wrap:wrap}
  .num{font-size:64px;font-weight:700;color:#C9A254;line-height:1}.num small{font-size:20px;color:#8EA3BC}
  .bars{flex:1;min-width:240px;display:flex;flex-direction:column;gap:8px}
  .bar{display:flex;align-items:center;gap:10px;font-size:12px}
  .bar span{width:74px;color:#8EA3BC;text-transform:capitalize}.bar b{width:44px;text-align:right;font-size:11.5px}
  .tr{flex:1;height:8px;background:#1E3A5C;border-radius:99px;overflow:hidden}.fl{height:100%;background:linear-gradient(90deg,#C9A254,#DDBE7A);border-radius:99px}
  .grid4{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
  .stat{background:#0C2036;border:1px solid #1E3A5C;border-radius:12px;padding:16px;text-align:center}
  .stat .v{font-size:26px;font-weight:700}.stat .l{font-size:11px;color:#8EA3BC;letter-spacing:.05em;text-transform:uppercase;margin-top:4px}
  ul.plan{list-style:none;display:flex;flex-direction:column;gap:9px;font-size:14.5px}
  ul.plan li::before{content:"✓  ";color:#059669;font-weight:700}
  .chipA{display:inline-block;background:#059669;color:#fff;font-size:11px;letter-spacing:.08em;padding:4px 12px;border-radius:99px;font-weight:700}
  ul.blog{list-style:none;display:flex;flex-direction:column;gap:8px}ul.blog a, .replist a{color:#DDBE7A;text-decoration:none;font-size:14.5px}
  .feed{display:flex;flex-direction:column;gap:9px;font-size:14px}.feed time{color:#5C7794;font-size:11.5px;display:block}
  .btn{display:inline-block;background:#C9A254;color:#0B1D33;font-weight:700;padding:14px 26px;border-radius:10px;text-decoration:none;border:0;font-size:15px;cursor:pointer}
  textarea{width:100%;background:#0C2036;border:1px solid #1E3A5C;border-radius:10px;color:#EDF2F7;padding:14px;font-family:inherit;font-size:14.5px;margin-bottom:12px}
  .foot{text-align:center;color:#5C7794;font-size:12px;margin-top:30px}.foot a{color:#8EA3BC}
  .two{display:grid;grid-template-columns:1fr;gap:0}@media(min-width:720px){.two{grid-template-columns:1fr 1fr;gap:18px}}
</style></head><body><div class="wrap">
  <div class="head">${slug ? `<img src="/preview/${slug}/img/logo.png" onerror="this.remove()">` : ''}<div><h1>${biz}</h1></div></div>
  <p class="sub">Your private client portal · ConversionCo ${isPremium ? '· <b style="color:#C9A254">★ Premium</b>' : ''}</p>

  <div class="card"><h2>Where your project stands</h2><div class="steps">
    ${PORTAL_STAGES.map(([k, label], i) => `<div class="step ${i < doneIdx ? 'done' : i === doneIdx ? 'now' : 'pend'}"><span class="dot">${i < doneIdx ? '✓' : i === doneIdx ? '●' : i + 1}</span>${label}</div>`).join('')}
  </div>${siteUrl ? `<a class="btn" href="${siteUrl}" target="_blank" style="margin-top:18px">View your website →</a>` : ''}</div>

  ${score ? `<div class="card"><h2>Your SEO Score</h2><div class="scorebig"><div class="num">${score.total}<small>/100</small></div><div class="bars">${bars}</div></div>
  <p style="color:#8EA3BC;font-size:12.5px;margin-top:14px">A real audit of your website's search-readiness — technical health, content depth, local signals, reliability, and off-site presence. It climbs as we work.</p></div>` : ''}

  <div class="card"><h2>Your investment at work</h2><div class="grid4">
    <div class="stat"><div class="v">${up && up.total ? up.total : '—'}</div><div class="l">Security checks run</div></div>
    <div class="stat"><div class="v">${upPct === null ? '—' : upPct + '%'}</div><div class="l">Uptime</div></div>
    <div class="stat"><div class="v">${score ? score.pages.total : '—'}</div><div class="l">Pages built &amp; maintained</div></div>
    <div class="stat"><div class="v">${score ? score.pages.blogPosts : 0}</div><div class="l">Articles written for you</div></div>
    <div class="stat"><div class="v">${revsN}</div><div class="l">Changes completed</div></div>
    <div class="stat"><div class="v">${leadsN}</div><div class="l">Leads captured</div></div>
  </div></div>

  <div class="two">
    <div class="card"><h2>Your plan${billing.sub_status === 'active' ? ' <span class="chipA">🛡 PROTECTED</span>' : ''}</h2>
      <ul class="plan">${plan.map((p) => `<li>${p}</li>`).join('')}</ul>
    </div>
    <div class="card"><h2>Recent activity</h2><div class="feed">
      ${evRows.length ? evRows.map((e) => `<div>${FRIENDLY[e.type] || e.type}<time>${e.created_at} UTC</time></div>`).join('') : '<p style="color:#8EA3BC;font-size:13.5px">Activity appears here as we work.</p>'}
    </div></div>
  </div>

  ${reports.length ? `<div class="card"><h2>Your performance reports</h2><div class="replist" style="display:flex;flex-direction:column;gap:8px">
    ${reports.map((r) => `<a href="/portal/${id}/${tok}/report/${r}" target="_blank">📊 ${r.replace('.html', '')}</a>`).join('')}
  </div></div>` : ''}

  ${blogs.length ? `<div class="card"><h2>Recently published for you</h2><ul class="blog">${blogs.map((b) => `<li><a href="/preview/${slug}/${b.path}" target="_blank">→ ${b.path.replace('blog-', '').replace('.html', '').replace(/-/g, ' ')}</a></li>`).join('')}</ul></div>` : ''}

  <div class="card"><h2>Message us</h2>
    <p style="color:#8EA3BC;font-size:13.5px;margin-bottom:12px">Questions, change requests, ideas — send them straight to your ConversionCo team. A human replies, usually same day.</p>
    <form id="msgForm"><textarea name="message" rows="3" required placeholder="Type your message…"></textarea>
    <button class="btn" type="submit">Send message</button>
    <p id="msgOk" style="display:none;color:#34D399;font-weight:600;margin-top:10px">Sent! We'll get back to you shortly. 💛</p></form>
  </div>

  <p class="foot">Website care by <a href="https://conversionco918.com">ConversionCo</a> · This portal updates in real time</p>
</div>
<script>
document.getElementById('msgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = new FormData(e.target).get('message');
  try { await fetch('/portal-msg/${id}/${tok}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg }) }); } catch {}
  e.target.querySelector('button').style.display = 'none';
  document.getElementById('msgOk').style.display = 'block';
});
</script>
</body></html>`);
});

// Portal message → instant email to Tiffany + logged like a lead
app.post('/portal-msg/:id/:token', async (c) => {
  const id = Number(c.req.param('id'));
  if (c.req.param('token') !== await portalToken(c.env, 'portal', id)) return c.text('nope', 403);
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'not found' }, 404);
  let f = {}; try { f = await c.req.json(); } catch {}
  const msg = String(f.message || '').slice(0, 2000);
  if (!msg.trim()) return c.json({ error: 'empty' }, 400);
  await db.prepare(`INSERT INTO leads (client_id, slug, name, email, phone, message) VALUES (?, 'portal-message', ?, ?, ?, ?)`)
    .bind(id, client.name || '', client.email || '', client.phone || '', msg).run();
  await logEvent(db, id, 'portal_message', `💬 Portal message from ${client.name || client.email}: "${msg.slice(0, 100)}"`);
  const settings = await getSettings(db);
  if (settings.notify_email && c.env.GHL_TOKEN && settings.ghl_location_id) {
    try {
      const ghl = ghlFor(c.env, settings);
      const contact = await ghl.upsertContact({ email: settings.notify_email, name: 'ConversionCo Notifications' });
      await ghl.sendEmail({ contactId: contact.id || contact.contactId,
        subject: `💬 Portal message from ${client.business_name || client.name || client.email}`,
        html: `<p><b>${client.name || ''}</b> (${client.email || ''}, ${client.phone || ''}) wrote via their portal:</p><blockquote style="border-left:3px solid #C9A254;padding-left:12px;">${msg.slice(0, 1200)}</blockquote><p><a href="${BASE_URL}">Open Mission Control</a></p>`,
        emailFrom: settings.email_from || undefined });
    } catch {}
  }
  return c.json({ ok: true });
});

// Render a stored report inside the portal (proxied from GitHub)
app.get('/portal/:id/:token/report/:name', async (c) => {
  const id = Number(c.req.param('id'));
  if (c.req.param('token') !== await portalToken(c.env, 'portal', id)) return c.text('not found', 404);
  const name = c.req.param('name');
  if (!/^[\w.-]+\.html$/.test(name)) return c.text('bad name', 400);
  const db = c.env.DB;
  const slug = await slugForClient(db, id);
  if (!slug || !c.env.GITHUB_TOKEN) return c.text('no reports', 404);
  const settings = await getSettings(db);
  const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/reports/${slug}/${name}`, {
    headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' } });
  if (!r.ok) return c.text('report not found', 404);
  const data = await r.json();
  const html = decodeURIComponent(escape(atob((data.content || '').replace(/\n/g, ''))));
  return c.html(html);
});

// Pitch page: personalized pre-proposal generated from Intake 1
app.get('/pitch/:id/:token', async (c) => {
  const id = Number(c.req.param('id'));
  if (c.req.param('token') !== await portalToken(c.env, 'pitch', id)) return c.text('not found', 404);
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.text('not found', 404);
  let i1 = {}; try { i1 = JSON.parse(client.intake1_data || '{}'); } catch {}
  const biz = client.business_name || i1['Business Name'] || client.name || 'Your IV Bar';
  const loc = (i1['Location'] || 'your city').split(',')[0];
  const { tokens } = vibeToTokens(client.vibe || 'warm luxury elegant');
  const t = tokens;
  const settings = await getSettings(db);
  const drips = [['Hydration', '#5BC8D8'], ['Recovery', '#E8873A'], ['Glow', '#E88BA5']];
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>A website for ${biz} — ConversionCo</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;1,400&family=Outfit:wght@300;400;600&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0}body{font-family:'Outfit',sans-serif;background:${t['--porcelain']};color:${t['--espresso']};line-height:1.65}
  .hero{background:${t['--night']};color:${t['--porcelain']};padding:90px 20px 70px;text-align:center}
  .eyebrow{font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:${t['--gold-soft']}}
  h1{font-family:'Cormorant Garamond',serif;font-size:clamp(44px,9vw,84px);font-weight:400;margin:16px 0 8px}
  h1 em{font-style:italic;color:${t['--gold-soft']}}
  .hero p{color:${t['--taupe']};max-width:46ch;margin:0 auto}
  .wrap{max-width:860px;margin:0 auto;padding:56px 20px}
  .drips{display:flex;gap:18px;justify-content:center;flex-wrap:wrap;margin:-40px auto 0;position:relative}
  .drip{background:${t['--night']};border-radius:14px;padding:26px 20px;width:150px;text-align:center;color:${t['--porcelain']};box-shadow:0 18px 40px rgba(0,0,0,.25)}
  .bag{width:44px;height:64px;border-radius:10px 10px 14px 14px;margin:0 auto 12px;position:relative}
  .drip span{font-family:'Cormorant Garamond',serif;font-size:17px}
  h2{font-family:'Cormorant Garamond',serif;font-size:clamp(28px,5vw,40px);font-weight:400;text-align:center;margin-bottom:10px}
  .sub{text-align:center;color:${t['--cocoa']};max-width:52ch;margin:0 auto 36px}
  .pk{display:flex;gap:18px;flex-wrap:wrap;justify-content:center}
  .p{background:#fff;border:1px solid ${t['--bone']};border-radius:16px;padding:30px;width:300px}
  .p h3{font-family:'Cormorant Garamond',serif;font-size:24px}.p .pr{font-size:38px;font-weight:600;margin:8px 0}
  .p ul{padding-left:18px;color:${t['--cocoa']};font-size:14px;margin:12px 0}
  .p.best{border:2px solid ${t['--gold']};position:relative}
  .p.best::before{content:"MOST POPULAR";position:absolute;top:-11px;left:50%;transform:translateX(-50%);background:${t['--gold']};color:#fff;font-size:10px;letter-spacing:.15em;padding:4px 12px;border-radius:99px}
  .cta{text-align:center;background:${t['--night']};color:${t['--porcelain']};padding:60px 20px;margin-top:56px}
  .btn{display:inline-block;background:${t['--gold']};color:${t['--night']};font-weight:600;padding:16px 34px;border-radius:10px;text-decoration:none;margin-top:14px}
  .foot{text-align:center;font-size:12px;color:${t['--taupe']};padding:26px}
</style></head><body>
  <div class="hero"><span class="eyebrow">Prepared exclusively for</span><h1>${biz.replace(/ IV| Iv/, ' <em>IV</em>')}</h1>
  <p>A glimpse of the website we'd build for you — luxury design, glowing drip menu, and Google-ready from day one, serving ${loc}.</p></div>
  <div class="drips">${drips.map(([n, col]) => `<div class="drip"><div class="bag" style="background:radial-gradient(ellipse at 50% 35%, ${col}, ${col}66);box-shadow:0 0 28px ${col}88"></div><span>The ${n}</span></div>`).join('')}</div>
  <div class="wrap"><h2>Two ways to start</h2><p class="sub">Both include custom luxury design, mobile-first build, booking integration, and full search-engine setup — reviewed with you before anything goes live.</p>
  <div class="pk">
    <div class="p"><h3>Standard</h3><div class="pr">$649</div><ul><li>6-page custom website</li><li>Glowing IV drip menu</li><li>Booking built in</li><li>Full SEO foundation</li><li>Monthly performance report</li></ul></div>
    <div class="p best"><h3>Premium</h3><div class="pr">$999</div><ul><li>Everything in Standard</li><li>A landing page for every drip</li><li>City pages for local Google</li><li>Weekly SEO blog — written for you</li><li>Weekly performance report</li></ul></div>
  </div>
  <p class="sub" style="margin-top:26px"><b>Simple, fair payments:</b> 50% to begin, 50% only when your finished website is delivered — you never pay in full for something you haven't seen.</p>
  <p class="sub" style="margin-top:10px">+ $49/month hosting &amp; security — daily uptime checks, monitoring, and updates. Starts only when your site is live.</p></div>
  <div class="cta"><h2 style="color:inherit">Ready when you are, ${(client.name || 'friend').split(' ')[0]}.</h2>
  <p style="opacity:.75">Grab a time and we'll walk through it together.</p>
  ${settings.booking_link ? `<a class="btn" href="${settings.booking_link}">Book your call</a>` : ''}</div>
  <div class="foot">Crafted by ConversionCo · conversionco918.com</div>
</body></html>`);
});

// Lead capture from client sites (public, CORS)
app.options('/lead/:slug', (c) => { corsHeaders(c); return c.body(null, 204); });
app.post('/lead/:slug', async (c) => {
  corsHeaders(c);
  const slug = c.req.param('slug');
  const db = c.env.DB;
  let f = {}; try { f = await c.req.json(); } catch { try { f = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)])); } catch {} }
  const meta = await db.prepare(`SELECT content FROM site_files WHERE slug=? AND path='site-meta.json'`).bind(slug).first();
  let clientId = null; try { clientId = JSON.parse(meta?.content || '{}').client_id ?? null; } catch {}
  await db.prepare(`INSERT INTO leads (client_id, slug, name, email, phone, message) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(clientId, slug, String(f.name || '').slice(0, 120), String(f.email || '').slice(0, 160), String(f.phone || '').slice(0, 40), String(f.message || '').slice(0, 1500)).run();
  await logEvent(db, clientId, 'lead_received', `🔥 New lead on ${slug}: ${f.name || 'no name'} ${f.phone || f.email || ''}`);
  const settings = await getSettings(db);
  if (settings.notify_email && c.env.GHL_TOKEN && settings.ghl_location_id) {
    try {
      const ghl = ghlFor(c.env, settings);
      const contact = await ghl.upsertContact({ email: settings.notify_email, name: 'ConversionCo Notifications' });
      await ghl.sendEmail({ contactId: contact.id || contact.contactId,
        subject: `🔥 New lead for ${slug}: ${f.name || 'someone'}`,
        html: `<p><b>${f.name || ''}</b> · ${f.phone || ''} · ${f.email || ''}</p><p>${String(f.message || '').slice(0, 600)}</p><p>Site: ${slug}</p>`,
        emailFrom: settings.email_from || undefined });
    } catch {}
  }
  return c.json({ ok: true });
});

// Public portfolio feed (for the ConversionCo showcase page)
app.get('/portfolio.json', async (c) => {
  const db = c.env.DB;
  const clients = (await db.prepare(`SELECT * FROM clients WHERE stage IN ('preview_ready','live')`).all()).results || [];
  const settings = await getSettings(db);
  const out = [];
  for (const cl of clients) {
    const score = await computeScore(db, cl, settings).catch(() => null);
    let up = null; try { up = JSON.parse(settings[`uptime_${cl.id}`] || 'null'); } catch {}
    out.push({ business: cl.business_name || cl.name, url: cl.live_url || cl.preview_url,
      tier: cl.tier || 'standard', score: score?.total ?? null, pages: score?.pages?.total ?? null,
      uptimePct: up && up.total ? Math.round(100 * (up.total - (up.fails || 0)) / up.total) : null });
  }
  c.header('Access-Control-Allow-Origin', '*');
  return c.json({ sites: out });
});

// Everything below requires a session
app.use('*', async (c, next) => {
  if (await checkSession(c.env, c.req.header('Cookie'))) return next();
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'unauthorized' }, 401);
  return c.html(loginHtml.replace('<!--ERROR-->', ''));
});

app.get('/', (c) => c.html(dashboardHtml));

// ---------------- API: clients ----------------
// Money + Needs-You + health, computed from data the system already tracks
async function computeOverview(db, clients, settings) {
  const signedRows = (await db.prepare('SELECT DISTINCT client_id FROM agreements').all()).results || [];
  const signed = new Set(signedRows.map((r) => r.client_id));
  const revFailed = (await db.prepare(`SELECT client_id, request FROM revisions WHERE status='failed' ORDER BY id DESC LIMIT 20`).all()).results || [];
  const revFailedByClient = {};
  for (const r of revFailed) (revFailedByClient[r.client_id] = revFailedByClient[r.client_id] || []).push(r.request);
  const newLeads = (await db.prepare(`SELECT l.*, c.business_name AS cbiz, c.name AS cname FROM leads l LEFT JOIN clients c ON c.id = l.client_id WHERE l.created_at > datetime('now','-2 days') ORDER BY l.id DESC LIMIT 20`).all()).results || [];

  let collected = 0, outstanding = 0, hostingCount = 0;
  const needs = [], health = {};
  const dayMs = 86400000;
  for (const cl of clients) {
    if (cl.stage === 'archived') { health[cl.id] = { dot: 'gray', why: 'archived' }; continue; }
    const label = cl.business_name || cl.name || cl.email;
    let b = {}; try { b = JSON.parse(cl.billing || '{}'); } catch {}
    const tierKey = b.invoice_tier || (cl.tier === 'premium' ? 'premium' : 'standard');
    const amt = PRICES[tierKey].amount / 100, half = amt / 2;
    if (b.invoice_status === 'paid') collected += amt; // legacy full invoice
    else {
      if (b.dep_status === 'paid') collected += half;
      else if (b.dep_status === 'open') { outstanding += half; needs.push({ id: cl.id, sev: 2, kind: 'invoice', msg: `💳 ${label} — 50% deposit outstanding (${halfDisplay(tierKey)})` }); }
      if (b.fin_status === 'paid') collected += half;
      else if (b.fin_status === 'open') { outstanding += half; needs.push({ id: cl.id, sev: 2, kind: 'invoice', msg: `💳 ${label} — final balance outstanding (${halfDisplay(tierKey)})` }); }
    }
    if (b.invoice_status === 'open') { outstanding += amt; needs.push({ id: cl.id, sev: 2, kind: 'invoice', msg: `💳 ${label} — invoice outstanding (${PRICES[tierKey].display})` }); }
    if (b.sub_status === 'active') hostingCount++;

    let why = [], dot = 'green';
    let upt = {}; try { upt = JSON.parse(settings[`uptime_${cl.id}`] || '{}'); } catch {}
    if (upt.last === 'down') { dot = 'red'; why.push('site check failed'); needs.push({ id: cl.id, sev: 1, kind: 'down', msg: `⛔ ${label} — site check FAILED (${upt.how || ''})` }); }
    if (revFailedByClient[cl.id]) { dot = 'red'; why.push('revision needs attention'); needs.push({ id: cl.id, sev: 1, kind: 'revision', msg: `✏️ ${label} — revision needs attention: "${String(revFailedByClient[cl.id][0]).slice(0, 60)}"` }); }
    if (b.agr_sent && !signed.has(cl.id)) {
      const days = Math.floor((Date.now() - Date.parse(b.agr_sent)) / dayMs);
      if (days >= 2) { if (dot === 'green') dot = 'yellow'; why.push('agreement unsigned'); needs.push({ id: cl.id, sev: 2, kind: 'agreement', msg: `📄 ${label} — agreement unsigned for ${days} day${days === 1 ? '' : 's'} (nudge them)` }); }
    }
    if ((b.invoice_status === 'open' || b.dep_status === 'open' || b.fin_status === 'open') && dot === 'green') { dot = 'yellow'; why.push('invoice open'); }
    if (depositPaid(b) && !cl.intake2_data && !['generating', 'preview_ready', 'live'].includes(cl.stage)) {
      if (dot === 'green') dot = 'yellow'; why.push('deposit paid — needs Intake 2');
      if (cl.stage !== 'intake2_sent') needs.push({ id: cl.id, sev: 2, kind: 'intake2', msg: `🚀 ${label} — deposit PAID and ready: send Intake 2 to start their build` });
    }
    if (cl.stage === 'intake1_done') needs.push({ id: cl.id, sev: 3, kind: 'call', msg: `📞 ${label} — Intake 1 done, book/hold the pricing call` });
    health[cl.id] = { dot, why: why.join(' · ') || 'all good' };
  }
  for (const l of newLeads) needs.push({ id: l.client_id, sev: 3, kind: 'lead', msg: `🔥 New lead for ${l.cbiz || l.cname || 'client'}: ${l.name || l.email || l.phone || 'someone'} (${ago2(l.created_at)})` });
  needs.sort((a, b2) => a.sev - b2.sev);
  const buildProgress = {};
  for (const cl of clients) {
    if (cl.stage !== 'generating') continue;
    let prog = {}; try { prog = JSON.parse(settings[`buildprog_${cl.id}`] || '{}'); } catch {}
    buildProgress[cl.id] = { pct: prog.pct || 5, step: prog.step || 'Build started', started_at: prog.started_at || cl.updated_at };
  }
  return { money: { collected, outstanding, hostingCount, mrr: hostingCount * 49 }, needs: needs.slice(0, 12), health, buildProgress };
}
function ago2(iso) { if (!iso) return ''; const m = (Date.now() - Date.parse(iso + (String(iso).includes('Z') ? '' : 'Z'))) / 60000; if (m < 60) return `${Math.max(1, Math.floor(m))}m ago`; if (m < 1440) return `${Math.floor(m / 60)}h ago`; return `${Math.floor(m / 1440)}d ago`; }

app.get('/api/state', async (c) => {
  const db = c.env.DB;
  const clients = (await db.prepare('SELECT * FROM clients ORDER BY updated_at DESC').all()).results || [];
  const events = (await db.prepare(
    'SELECT e.*, c.name AS client_name, c.email AS client_email FROM events e LEFT JOIN clients c ON c.id = e.client_id ORDER BY e.id DESC LIMIT 50'
  ).all()).results || [];
  const settings = await getSettings(db);
  let overview = null;
  try { overview = await computeOverview(db, clients, settings); } catch { /* dashboard still renders without it */ }
  const webhookSecret = (await hmac(c.env.SESSION_SECRET, 'webhook')).slice(0, 16);
  return c.json({ clients, events, settings, overview, webhook_path: `/webhooks/ghl/${webhookSecret}` });
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
    await trySMS(ghl, db, clientId, contactId,
      `Hi ${firstName === 'there' ? '' : firstName + '! '}It's ConversionCo — excited to build your website. Step 1 is a quick 10-min intake form: ${settings.form1_link}`.replace('Hi It', "Hi! It"));
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
    await trySMS(ghl, db, id, contactId,
      `Hi ${firstName}! ConversionCo here — last step before design starts: your Website Vision form. ${link2}`);
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
  if (allowed.stage) {
    await logEvent(c.env.DB, id, 'stage_changed', `Moved to ${allowed.stage}`);
    // keep the progress bar honest when the stage is set by hand
    if (allowed.stage === 'generating') {
      await setSetting(c.env.DB, `buildprog_${id}`, JSON.stringify({ started_at: new Date().toISOString(), pct: 5, step: 'Waiting for the builder' }));
    } else {
      await setSetting(c.env.DB, `buildprog_${id}`, '');
    }
  }
  return c.json({ ok: true });
});

app.delete('/api/clients/:id', async (c) => {
  const id = Number(c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM clients WHERE id = ?').bind(id).run();
  await logEvent(c.env.DB, id, 'client_deleted');
  return c.json({ ok: true });
});

async function sendPortalEmail(env, db, client, settings) {
  if (!client?.email || !env.GHL_TOKEN || !settings.ghl_location_id) return false;
  const url = `${BASE_URL}/portal/${client.id}/${await portalToken(env, 'portal', client.id)}`;
  const biz = client.business_name || client.name || 'your business';
  const first = (client.name || '').split(' ')[0] || 'there';
  try {
    const ghl = new GHL(env.GHL_TOKEN, settings.ghl_location_id);
    const contact = await ghl.upsertContact({ email: client.email, name: client.name || '' });
    await ghl.sendEmail({
      contactId: contact.id || contact.contactId,
      subject: `Your private client portal — ${biz}`,
      html: `<p>Hi ${first},</p>
<p>You're officially on the books. Your private client portal is live — it's your window into everything we do for ${biz}: watch your website get built stage by stage, see your SEO score, your uptime monitoring, and everything we publish for you.</p>
<p><a href="${url}">${url}</a></p>
<p>That link is your personal key — no password needed. Bookmark it; it updates in real time, and you can message us directly from inside it any time. Or just reply to this email.</p>
<p>Talk soon,<br>The ConversionCo Team</p>`,
      emailFrom: settings.email_from || undefined,
    });
    await trySMS(ghl, db, client.id, contact.id || contact.contactId,
      `Hi ${first}! It's ConversionCo — you're officially on the books. Your private client portal is live (bookmark it): ${url}`);
    await logEvent(db, client.id, 'portal_invited', `Portal login auto-sent to ${client.email} 🔑`);
    return true;
  } catch { return false; }
}

// Best-effort SMS alongside key emails — clients can't miss the notification.
// DISABLED per Tiffany (7/23): flip SMS_ENABLED to true to turn texts back on.
const SMS_ENABLED = false;
async function trySMS(ghl, db, clientId, contactId, message) {
  if (!SMS_ENABLED) return false;
  try {
    await ghl.sendSMS({ contactId, message });
    await logEvent(db, clientId, 'sms_sent', `📱 Text sent: "${message.slice(0, 70)}…"`);
    return true;
  } catch (e) {
    await logEvent(db, clientId, 'sms_skipped', `Text not sent (${String(e.message || e).slice(0, 120)})`);
    return false;
  }
}

// ---------------- Stripe billing ----------------
function getBilling(client) { try { return JSON.parse(client.billing || '{}'); } catch { return {}; } }

app.post('/api/clients/:id/invoice', async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) return c.json({ error: 'Add the STRIPE_SECRET_KEY secret to the worker first (Cloudflare → worker → Settings → Variables)' }, 400);
  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'client not found' }, 404);
  const tierKey = (client.tier === 'premium') ? 'premium' : 'standard';
  let which = 'deposit';
  try { which = (await c.req.json())?.which || 'deposit'; } catch {}
  if (which !== 'final') which = 'deposit';
  try {
    const cust = await ensureCustomer(c.env.STRIPE_SECRET_KEY, client.email, client.name || client.business_name || '');
    const inv = await sendInvoice(c.env.STRIPE_SECRET_KEY, cust.id, tierKey, client.business_name || '', which);
    const billing = getBilling(client);
    billing.customer_id = cust.id; billing.invoice_tier = tierKey;
    if (which === 'deposit') { billing.dep_id = inv.id; billing.dep_status = inv.status; billing.dep_url = inv.url; }
    else { billing.fin_id = inv.id; billing.fin_status = inv.status; billing.fin_url = inv.url; }
    await touchClient(db, id, { billing: JSON.stringify(billing) });
    const halfLabel = which === 'deposit' ? '50% deposit' : 'final 50% balance';
    await logEvent(db, id, 'invoice_sent', `Stripe invoice sent — ${halfDisplay(tierKey)} ${halfLabel} (${PRICES[tierKey].label}) 💳`);
    return c.json({ ok: true, url: inv.url, display: halfDisplay(tierKey), which });
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
  const clients = (await db.prepare(`SELECT * FROM clients WHERE billing LIKE '%"invoice_status":"open"%' OR billing LIKE '%"dep_status":"open"%' OR billing LIKE '%"fin_status":"open"%' OR billing LIKE '%"sub_status":"pending"%'`).all()).results || [];
  let changed = 0;
  for (const client of clients) {
    const billing = getBilling(client);
    let dirty = 0;
    const tierKey = billing.invoice_tier || 'standard';
    try {
      // legacy full invoice
      if (billing.invoice_id && billing.invoice_status === 'open') {
        const st = await invoiceStatus(env.STRIPE_SECRET_KEY, billing.invoice_id);
        if (st.status !== billing.invoice_status) {
          billing.invoice_status = st.status;
          if (st.paid) {
            billing.paid_at = new Date().toISOString();
            await logEvent(db, client.id, 'invoice_paid', `Invoice PAID — ${PRICES[tierKey].display} 🎉💰`);
            const settingsP = await getSettings(db);
            await sendPortalEmail(env, db, client, settingsP);
          }
          dirty++;
        }
      }
      // 50% deposit — payment unlocks the build + portal
      if (billing.dep_id && billing.dep_status === 'open') {
        const st = await invoiceStatus(env.STRIPE_SECRET_KEY, billing.dep_id);
        if (st.status !== billing.dep_status) {
          billing.dep_status = st.status;
          if (st.paid) {
            billing.dep_paid_at = new Date().toISOString();
            await logEvent(db, client.id, 'invoice_paid', `50% deposit PAID (${halfDisplay(tierKey)}) — build unlocked 🎉💰`);
            const settingsP = await getSettings(db);
            await sendPortalEmail(env, db, client, settingsP);
          }
          dirty++;
        }
      }
      // final 50% balance
      if (billing.fin_id && billing.fin_status === 'open') {
        const st = await invoiceStatus(env.STRIPE_SECRET_KEY, billing.fin_id);
        if (st.status !== billing.fin_status) {
          billing.fin_status = st.status;
          if (st.paid) {
            billing.fin_paid_at = new Date().toISOString();
            await logEvent(db, client.id, 'invoice_paid', `Final balance PAID (${halfDisplay(tierKey)}) — project paid in full 💰✅`);
          }
          dirty++;
        }
      }
      if (billing.sub_session_id && billing.sub_status === 'pending') {
        const st = await checkoutStatus(env.STRIPE_SECRET_KEY, billing.sub_session_id);
        if (st.complete) {
          billing.sub_status = 'active'; billing.subscription_id = st.subscription;
          await logEvent(db, client.id, 'hosting_active', 'Hosting & security $49/mo ACTIVE 🔒✅');
          dirty++;
        }
      }
      if (dirty) { changed += dirty; await touchClient(db, client.id, { billing: JSON.stringify(billing) }); }
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
  } else if (what === 'final') {
    billing.fin_status = 'paid'; billing.fin_bypass = true; billing.fin_paid_at = new Date().toISOString();
    await logEvent(db, id, 'invoice_paid', 'Final balance marked PAID manually (bypass — paid outside Stripe) 🔓💰');
  } else {
    billing.dep_status = 'paid'; billing.dep_bypass = true; billing.dep_paid_at = new Date().toISOString();
    await logEvent(db, id, 'invoice_paid', '50% deposit marked PAID manually (bypass — paid outside Stripe) 🔓💰 — build unlocked');
    const settingsB = await getSettings(db);
    await sendPortalEmail(c.env, db, client, settingsB);
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

app.post('/api/clients/:id/revision', async (c) => {
  const id = Number(c.req.param('id'));
  const { request } = await c.req.json();
  if (!request || !String(request).trim()) return c.json({ error: 'describe the change first' }, 400);
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'client not found' }, 404);
  const r = await db.prepare('INSERT INTO revisions (client_id, request) VALUES (?, ?)').bind(id, String(request).slice(0, 2000)).run();
  await logEvent(db, id, 'revision_requested', `✏️ Revision queued: "${String(request).slice(0, 100)}"`);
  return c.json({ ok: true, id: r.meta.last_row_id });
});
app.get('/api/clients/:id/revisions', async (c) => {
  const rows = (await c.env.DB.prepare('SELECT * FROM revisions WHERE client_id = ? ORDER BY id DESC LIMIT 10').bind(Number(c.req.param('id'))).all()).results || [];
  return c.json({ revisions: rows });
});

// Email the client their portal login (magic link)
app.post('/api/clients/:id/portal-invite', async (c) => {
  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'client not found' }, 404);
  if (!client.email) return c.json({ error: 'client has no email' }, 400);
  const settings = await getSettings(db);
  if (!c.env.GHL_TOKEN || !settings.ghl_location_id) return c.json({ error: 'GHL not configured' }, 500);
  const url = `${BASE_URL}/portal/${id}/${await portalToken(c.env, 'portal', id)}`;
  const biz = client.business_name || client.name || 'your business';
  const first = (client.name || '').split(' ')[0] || 'there';
  try {
    const ghl = ghlFor(c.env, settings);
    const contact = await ghl.upsertContact({ email: client.email, name: client.name || '' });
    await ghl.sendEmail({
      contactId: contact.id || contact.contactId,
      subject: `Your private client portal — ${biz}`,
      html: `<p>Hi ${first},</p>
<p>Your project now has a live client portal — your window into everything we're doing for ${biz}: where your project stands, your website's SEO score, uptime monitoring, and everything we publish for you.</p>
<p><a href="${url}">${url}</a></p>
<p>That link is your personal key — no password needed. Bookmark it and check in any time; it updates in real time as we work. Or just reply to this email with any question.</p>
<p>Talk soon,<br>The ConversionCo Team</p>`,
      emailFrom: settings.email_from || undefined,
    });
    await trySMS(ghl, db, id, contact.id || contact.contactId,
      `Hi ${first}! It's ConversionCo — your private client portal is live (bookmark it): ${url}`);
    await logEvent(db, id, 'portal_invited', `Portal login emailed to ${client.email} 🔑`);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: 'Email failed: ' + e.message }, 502);
  }
});

app.post('/api/clients/:id/agreement-invite', async (c) => {
  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client || !client.email) return c.json({ error: 'client/email missing' }, 400);
  const settings = await getSettings(db);
  if (!c.env.GHL_TOKEN || !settings.ghl_location_id) return c.json({ error: 'GHL not configured' }, 500);
  const url = `${BASE_URL}/agreement/${id}/${await portalToken(c.env, 'agr', id)}`;
  const biz = client.business_name || client.name || 'your business';
  try {
    const ghl = ghlFor(c.env, settings);
    const contact = await ghl.upsertContact({ email: client.email, name: client.name || '' });
    await ghl.sendEmail({ contactId: contact.id || contact.contactId,
      subject: `One quick signature before we begin — ${biz}`,
      html: `<p>Hi ${(client.name || '').split(' ')[0] || 'there'},</p>
<p>We're excited to build this with you. Before your invoice, here's our service agreement — plain English, about two minutes to read, and it protects both of us. The short version: your domain and your website are yours, and it spells out exactly what our service covers:</p>
<p><a href="${url}">${url}</a></p>
<p>Your invoice follows right after you sign. Questions about anything in it? Just reply — happy to walk you through.</p>
<p>Talk soon,<br>The ConversionCo Team</p>`,
      emailFrom: settings.email_from || undefined });
    await trySMS(ghl, db, id, contact.id || contact.contactId,
      `Hi ${(client.name || '').split(' ')[0] || 'there'}! ConversionCo here — quick e-signature on your service agreement before we begin (2-min read): ${url}`);
    let billing = {}; try { billing = JSON.parse(client.billing || '{}'); } catch {}
    billing.agr_sent = new Date().toISOString();
    await touchClient(db, id, { billing: JSON.stringify(billing) });
    await logEvent(db, id, 'agreement_sent', `📄 Agreement sent to ${client.email}`);
    return c.json({ ok: true, url });
  } catch (e) { return c.json({ error: 'Email failed: ' + e.message }, 502); }
});
app.get('/api/clients/:id/agreement', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM agreements WHERE client_id = ? ORDER BY id DESC LIMIT 1').bind(Number(c.req.param('id'))).first();
  return c.json({ signed: row || null });
});

app.get('/api/clients/:id/leads', async (c) => {
  const id = Number(c.req.param('id'));
  const rows = (await c.env.DB.prepare('SELECT * FROM leads WHERE client_id = ? ORDER BY id DESC LIMIT 12').bind(id).all()).results || [];
  return c.json({ leads: rows });
});
app.get('/api/clients/:id/links', async (c) => {
  const id = Number(c.req.param('id'));
  return c.json({
    portal: `${BASE_URL}/portal/${id}/${await portalToken(c.env, 'portal', id)}`,
    pitch: `${BASE_URL}/pitch/${id}/${await portalToken(c.env, 'pitch', id)}`,
    agreement: `${BASE_URL}/agreement/${id}/${await portalToken(c.env, 'agr', id)}`,
  });
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
    // 50/50 billing: the build is done — auto-send the final balance invoice
    try {
      const clientF = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(Number(clientId)).first();
      const bF = getBilling(clientF);
      if (env.STRIPE_SECRET_KEY && bF.dep_status === 'paid' && !bF.fin_id && !bF.fin_status && bF.invoice_status !== 'paid') {
        const tierKeyF = bF.invoice_tier || (clientF.tier === 'premium' ? 'premium' : 'standard');
        const custId = bF.customer_id || (await ensureCustomer(env.STRIPE_SECRET_KEY, clientF.email, clientF.name || clientF.business_name || '')).id;
        const invF = await sendInvoice(env.STRIPE_SECRET_KEY, custId, tierKeyF, clientF.business_name || '', 'final');
        bF.customer_id = custId; bF.fin_id = invF.id; bF.fin_status = invF.status; bF.fin_url = invF.url;
        await touchClient(db, Number(clientId), { billing: JSON.stringify(bF) });
        await logEvent(db, Number(clientId), 'invoice_sent', `Build done — final balance invoice auto-sent (${halfDisplay(tierKeyF)}) 💳`);
      }
    } catch (e) { await logEvent(db, Number(clientId), 'error', `Final invoice auto-send failed: ${e.message}`); }
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

// Build watchdog (runs every 5 min): a card stuck in "Building" with no progress
// for 60+ minutes gets re-queued automatically and flagged in the activity feed —
// a stalled build can never sit silently again.
async function buildWatchdog(env, settings) {
  const db = env.DB;
  const gen = (await db.prepare(`SELECT * FROM clients WHERE stage = 'generating'`).all()).results || [];
  for (const cl of gen) {
    let prog = {}; try { prog = JSON.parse(settings[`buildprog_${cl.id}`] || '{}'); } catch {}
    const lastBeat = Date.parse(prog.updated_at || prog.started_at || cl.updated_at || 0);
    if (!lastBeat || Date.now() - lastBeat < 60 * 60000) continue;
    const mins = Math.round((Date.now() - lastBeat) / 60000);
    await touchClient(db, cl.id, { stage: cl.intake2_data ? 'intake2_done' : 'intake2_sent' });
    await setSetting(db, `buildprog_${cl.id}`, '');
    await logEvent(db, cl.id, 'build_stalled', `⚠️ Build showed no progress for ${mins} min — automatically re-queued for the next builder run (${cl.business_name || cl.name || cl.email})`);
  }
}

// Monday owner's digest: the week in one email, straight to Tiffany
async function weeklyOwnerDigest(env) {
  const db = env.DB;
  const settings = await getSettings(db);
  if (!env.GHL_TOKEN || !settings.ghl_location_id) return;
  const to = settings.notify_email || 'tiffany.anywhereinfusions@gmail.com';
  const clients = (await db.prepare('SELECT * FROM clients ORDER BY updated_at DESC').all()).results || [];
  const overview = await computeOverview(db, clients, settings);
  const wk = (await db.prepare(`SELECT type, COUNT(*) AS n FROM events WHERE created_at > datetime('now','-7 days') GROUP BY type`).all()).results || [];
  const count = (t) => wk.find((r) => r.type === t)?.n || 0;
  const leads7 = (await db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE created_at > datetime('now','-7 days')`).first())?.n || 0;
  const money = overview.money;
  const row = (k, v) => `<tr><td style="padding:6px 14px 6px 0;color:#64748b;font-size:13px;">${k}</td><td style="padding:6px 0;font-weight:700;font-size:14px;color:#0B1D33;">${v}</td></tr>`;
  const needsHtml = overview.needs.length
    ? `<ol style="padding-left:18px;margin:8px 0;">${overview.needs.map((n) => `<li style="margin:6px 0;font-size:13.5px;">${n.msg}</li>`).join('')}</ol>`
    : `<p style="font-size:13.5px;">Nothing is waiting on you — the machine is humming. 🎉</p>`;
  try {
    const ghl = new GHL(env.GHL_TOKEN, settings.ghl_location_id);
    const contact = await ghl.upsertContact({ email: to, name: 'ConversionCo Owner' });
    await ghl.sendEmail({
      contactId: contact.id || contact.contactId,
      subject: `📊 Your ConversionCo week — $${money.collected} collected · ${leads7} lead${leads7 === 1 ? '' : 's'} · MRR $${money.mrr}`,
      html: `<h2 style="color:#0B1D33;margin:0 0 4px;">Your week at ConversionCo</h2>
<p style="color:#64748b;font-size:13px;margin:0 0 16px;">Every number below is live from Mission Control.</p>
<table style="border-collapse:collapse;">
${row('Cash collected (all time)', `$${money.collected.toLocaleString()}`)}
${row('Invoices outstanding', `$${money.outstanding.toLocaleString()}`)}
${row('Hosting subscriptions', `${money.hostingCount} active — <b>$${money.mrr}/mo recurring</b>`)}
${row('New leads (7 days)', leads7)}
${row('Intakes submitted (7 days)', count('intake1_done') + count('intake2_done'))}
${row('Invoices paid (7 days)', count('invoice_paid'))}
${row('Sites hitting preview (7 days)', count('preview_ready') || count('site_published'))}
${row('Revisions applied (7 days)', count('revision_done'))}
</table>
<h3 style="color:#0B1D33;margin:18px 0 4px;">Waiting on you</h3>
${needsHtml}
<p style="margin:22px 0;"><a href="${BASE_URL}" style="background:#0B1D33;color:#fff;padding:13px 26px;border-radius:8px;text-decoration:none;font-weight:bold;">Open Mission Control &rarr;</a></p>
<p style="font-size:12.5px;color:#667788;">Button not working? Copy this link into your browser:<br><span style="color:#0B1D33;word-break:break-all;">${BASE_URL}</span></p>`,
      emailFrom: settings.email_from || undefined,
    });
    await logEvent(db, null, 'owner_digest', `📊 Weekly owner digest sent to ${to}`);
  } catch (e) { await logEvent(db, null, 'error', `Owner digest failed: ${e.message}`); }
}

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    await ensureSchema(env.DB);
    if (event.cron === '0 12 * * *') {
      ctx.waitUntil(dailyUptime(env).catch((e) =>
        logEvent(env.DB, null, 'error', `Uptime check failed: ${e.message}`)
      ));
      if (new Date(event.scheduledTime || Date.now()).getUTCDay() === 1) {
        ctx.waitUntil(weeklyOwnerDigest(env).catch((e) =>
          logEvent(env.DB, null, 'error', `Owner digest failed: ${e.message}`)
        ));
      }
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
    ctx.waitUntil(buildWatchdog(env, settings).catch((e) =>
      logEvent(env.DB, null, 'error', `Build watchdog failed: ${e.message}`)
    ));
  },
};
