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
import { gscConfigured, gscAddProperty, gscVerifyViaCloudflareDns, gscQueryStats, gscSubmitSitemap, gscGetDnsToken, gscRequestVerify, gscListProperties } from './google.js';
import { buildZip } from './zipfile.js';
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
  try { await db.prepare(`ALTER TABLE leads ADD COLUMN source TEXT DEFAULT ''`).run(); } catch {}
  try { await db.prepare(`ALTER TABLE leads ADD COLUMN status TEXT DEFAULT ''`).run(); } catch {}
  // 🎯 CLOSED-LOOP ADS (8/20) — without these columns Google can never learn
  // which clicks became customers, so it optimises for form fills instead of
  // revenue. gclid is the join key back to the click that was paid for.
  for (const col of ['gclid', 'wbraid', 'gbraid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'landing_page', 'device', 'referrer', 'kind', 'status_at']) {
    try { await db.prepare(`ALTER TABLE leads ADD COLUMN ${col} TEXT DEFAULT ''`).run(); } catch {}
  }
  try { await db.prepare(`ALTER TABLE leads ADD COLUMN value REAL DEFAULT 0`).run(); } catch {}
  // golive-domain has always written launched_at, but the column never existed —
  // so the UPDATE threw and the whole launch returned a 500 AFTER it had already
  // succeeded. (Found 8/20 on the anywhereinfusions.com launch.)
  try { await db.prepare(`ALTER TABLE clients ADD COLUMN launched_at TEXT DEFAULT ''`).run(); } catch {}
  try { await db.prepare(`CREATE INDEX IF NOT EXISTS idx_leads_gclid ON leads(gclid)`).run(); } catch {}
  try { await db.prepare(`CREATE INDEX IF NOT EXISTS idx_leads_client_created ON leads(client_id, created_at)`).run(); } catch {}
  try { await db.prepare(`ALTER TABLE clients ADD COLUMN competitors TEXT DEFAULT ''`).run(); } catch {}
  // 🤖 AEO entity resolution: the off-site profiles that prove the website, the
  // Google listing, the Facebook page and the Yelp page are ONE business. Without
  // these an answer engine sees four similar businesses and trusts none of them.
  try { await db.prepare(`ALTER TABLE clients ADD COLUMN profiles TEXT DEFAULT ''`).run(); } catch {}
  try { await db.prepare(`ALTER TABLE clients ADD COLUMN hours TEXT DEFAULT ''`).run(); } catch {}
  try { await db.prepare(`ALTER TABLE clients ADD COLUMN vertical TEXT DEFAULT ''`).run(); } catch {}
  try { await db.prepare(`ALTER TABLE site_files ADD COLUMN gh_sha TEXT DEFAULT ''`).run(); } catch {}
  // 🤖 AEO (answer-engine optimisation): one row per site/day/engine/kind.
  // kind='referral' = a human arrived from an AI answer. kind='answer' = an AI
  // fetched the page to answer a live question. kind='train' = a training crawler.
  // These are three completely different things and must never be added together.
  try { await db.prepare(`CREATE TABLE IF NOT EXISTS ai_visits (
    slug TEXT NOT NULL, day TEXT NOT NULL, engine TEXT NOT NULL, kind TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (slug, day, engine, kind))`).run(); } catch {}
  // first-party visitor counting: one row per site/day/page (HTML views only, bots skipped)
  try { await db.prepare(`CREATE TABLE IF NOT EXISTS hits (
    slug TEXT NOT NULL, day TEXT NOT NULL, path TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (slug, day, path))`).run(); } catch {}
  // email delivery log: every client-facing send recorded; failed ones retried by the cron
  try { await db.prepare(`CREATE TABLE IF NOT EXISTS email_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER, to_email TEXT DEFAULT '',
    subject TEXT DEFAULT '', html TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'sent',
    attempts INTEGER NOT NULL DEFAULT 1, error TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT DEFAULT '')`).run(); } catch {}
  // fixed-window rate limiting for the public endpoints (lead form, portal boxes)
  try { await db.prepare(`CREATE TABLE IF NOT EXISTS ratelimit (
    k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, win TEXT NOT NULL DEFAULT '')`).run(); } catch {}
  // ⭐ rankings history: one row per client/keyword/day, straight from GSC (accuracy law)
  try { await db.prepare(`CREATE TABLE IF NOT EXISTS rank_history (
    client_id INTEGER NOT NULL, q TEXT NOT NULL, day TEXT NOT NULL,
    pos REAL NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, impr INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (client_id, q, day))`).run(); } catch {}
  schemaReady = true;
}

app.use('*', async (c, next) => {
  await ensureSchema(c.env.DB);
  return next();
});

// 🌉 SAME-ORIGIN PUSH BRIDGE: a tiny receiver page opened as a popup from an
// authenticated tool tab (e.g. ChatGPT). That tab cannot POST here directly
// (its CSP blocks cross-origin fetch), so it postMessages {type:'push', path,
// body, id} to this page, which runs the POST same-origin and replies to the
// opener. No secret is baked in — the caller supplies the keyed path per push.
app.get('/__bridge', (c) => c.html(`<!doctype html><meta charset=utf-8><title>bridge</title>
<body style="font:14px system-ui;padding:12px">push bridge ready
<script>
var OPENER_ORIGIN='https://chatgpt.com';
addEventListener('message', function(e){
  if(e.origin!==OPENER_ORIGIN) return;
  var m=e.data||{};
  if(m.type!=='push') return;
  var reply=function(o){ try{ e.source.postMessage(Object.assign({id:m.id,type:'push-result'},o), e.origin); }catch(x){} };
  try{
    fetch(m.path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(m.body)})
      .then(function(r){ return r.text().then(function(t){ var j; try{j=JSON.parse(t)}catch(_){j=t} reply({ok:r.ok,status:r.status,r:j}); }); })
      .catch(function(err){ reply({ok:false,err:String(err)}); });
  }catch(err){ reply({ok:false,err:String(err)}); }
});
try{ if(window.opener) window.opener.postMessage({type:'bridge-ready'}, OPENER_ORIGIN); }catch(x){}
</script>`));

// 🌐 DIRECT LIVE HOSTING: when a client's custom domain points at this worker,
// serve their site straight from storage — no separate hosting anywhere.
// Mapping lives in settings: livehost_<hostname> = slug (set by golive-domain).
app.use('*', async (c, next) => {
  const host = (c.req.header('Host') || '').toLowerCase().split(':')[0];
  if (!host || host.endsWith('.workers.dev')) return next();
  const settings = await getSettings(c.env.DB);
  const slug = settings[`livehost_${host}`] || settings[`livehost_${host.replace(/^www\./, '')}`];
  if (!slug) return next();

  // 🔎 SEO LAW — ONE ADDRESS PER SITE (Tiffany 8/20: "whatever helps seo").
  // www.example.com and example.com are two different addresses to Google. If
  // both answer 200, Google can keep two records and split the credit from
  // links, reviews and directory listings between them. A canonical tag is a
  // suggestion Google may ignore; a 301 is a rule it cannot. So www permanently
  // redirects to the bare domain, carrying path and query untouched, and every
  // link anywhere on the internet lands on the one canonical address.
  // 301 (not 302) is deliberate: only a permanent redirect passes ranking value.
  if (host.startsWith('www.')) {
    const bare = host.slice(4);
    if (settings[`livehost_${bare}`]) {
      const url = new URL(c.req.url);
      url.host = bare; url.protocol = 'https:'; url.port = '';
      return c.redirect(url.toString(), 301);
    }
  }

  let path = c.req.path.replace(/^\/+/, '') || 'index.html';
  if (path === '' || path.endsWith('/')) path += 'index.html';
  let row = await c.env.DB.prepare('SELECT * FROM site_files WHERE slug = ? AND path = ?').bind(slug, path).first();
  if (!row && !path.includes('.')) {
    row = await c.env.DB.prepare('SELECT * FROM site_files WHERE slug = ? AND path = ?').bind(slug, path + '/index.html').first()
      || await c.env.DB.prepare('SELECT * FROM site_files WHERE slug = ? AND path = ?').bind(slug, path + '.html').first();
  }
  if (!row) {
    const nf = await c.env.DB.prepare(`SELECT * FROM site_files WHERE slug = ? AND path = '404.html'`).bind(slug).first();
    if (nf) return new Response(nf.is_base64 ? Uint8Array.from(atob(nf.content), (ch) => ch.charCodeAt(0)) : nf.content,
      { status: 404, headers: { 'Content-Type': 'text/html' } });
    return c.text('Not found', 404);
  }
  try {
    const ua = c.req.header('User-Agent') || '';
    const isHtml = String(row.content_type || '').includes('text/html');
    const isBot = /bot|crawl|spider|slurp|headless|preview|monitor|lighthouse|pingdom/i.test(ua) || !ua;
    const isFrame = (c.req.header('Sec-Fetch-Dest') || '') === 'iframe';
    // AEO: an AI agent reading the page counts even though it is a "bot" —
    // that is the whole point of the signal, so it is measured BEFORE the bot filter.
    if (isHtml) {
      const ag = aiAgent(ua);
      if (ag) c.executionCtx.waitUntil(noteAi(c.env, slug, ag.engine, ag.kind));
      else {
        const ref = aiReferral(c.req.header('Referer'), c.req.query('utm_source'));
        if (ref) c.executionCtx.waitUntil(noteAi(c.env, slug, ref, 'referral'));
      }
    }
    if (isHtml && !isBot && !isFrame) {
      const day = new Date().toISOString().slice(0, 10);
      c.executionCtx.waitUntil(c.env.DB.prepare(
        `INSERT INTO hits (slug, day, path, n) VALUES (?, ?, ?, 1)
         ON CONFLICT(slug, day, path) DO UPDATE SET n = n + 1`
      ).bind(slug, day, path).run().catch(() => {}));
    }
  } catch { /* counting must never break serving */ }
  const body = row.is_base64 ? Uint8Array.from(atob(row.content), (ch) => ch.charCodeAt(0)) : row.content;
  // A preview is a COMPLETE SECOND COPY of the client's website on a domain we
  // own. A canonical tag is only a hint, and AI crawlers honour it inconsistently
  // — so the copy has to refuse indexing outright, or a client can end up cited
  // at a workers.dev URL that looks like nothing to a customer.
  return new Response(body, { headers: {
    'Content-Type': row.content_type,
    'Cache-Control': 'public, max-age=300',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  } });
});

// ══ AEO DETECTION ══════════════════════════════════════════════════════════
// Being found through an AI assistant is a different channel from Google search,
// and it splits into three signals that are constantly conflated by the tools
// that sell "AI visibility". We keep them apart on purpose:
//
//   answer   — an AI fetched this page to answer somebody's live question.
//              Proof the door is open and the content is being consulted.
//   referral — a human read that answer, clicked the citation, and landed here.
//              The only one of the three that is a visitor, and the only one
//              that can become a booking.
//   train    — a crawler taking content to train a model. Not visibility.
//              Recorded so the number is honest, never counted as a win.
//
// Adding these together would let us show a client a big impressive number that
// means nothing. Each is reported on its own line.
const AI_AGENTS = [
  // live answering (a person is waiting on the other end)
  [/ChatGPT-User/i,        'ChatGPT',    'answer'],
  [/OAI-SearchBot/i,       'ChatGPT',    'answer'],
  [/Perplexity-User/i,     'Perplexity', 'answer'],
  [/PerplexityBot/i,       'Perplexity', 'answer'],
  [/Claude-User/i,         'Claude',     'answer'],
  [/Claude-SearchBot/i,    'Claude',     'answer'],
  [/Google-Extended/i,     'Gemini',     'answer'],
  [/DuckAssistBot/i,       'DuckDuckGo', 'answer'],
  // training / bulk collection
  [/GPTBot/i,              'ChatGPT',    'train'],
  [/ClaudeBot/i,           'Claude',     'train'],
  [/CCBot/i,               'CommonCrawl','train'],
  [/Bytespider/i,          'TikTok',     'train'],
  [/Amazonbot/i,           'Amazon',     'train'],
  [/Applebot-Extended/i,   'Apple',      'train'],
  [/meta-externalagent/i,  'Meta',       'train'],
  [/cohere-ai|cohere-training/i, 'Cohere', 'train'],
];
function aiAgent(ua) {
  const s = String(ua || '');
  for (const [re, engine, kind] of AI_AGENTS) if (re.test(s)) return { engine, kind };
  return null;
}
// Referrers an AI assistant sends a human here with. OpenAI also tags some links
// with ?utm_source=chatgpt.com, so the query string is checked as a fallback.
const AI_REFS = [
  [/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/i, 'ChatGPT'],
  [/(^|\.)perplexity\.ai$/i,                        'Perplexity'],
  [/(^|\.)claude\.ai$/i,                            'Claude'],
  [/(^|\.)gemini\.google\.com$|(^|\.)bard\.google\.com$/i, 'Gemini'],
  [/(^|\.)copilot\.microsoft\.com$/i,               'Copilot'],
  [/(^|\.)you\.com$/i,                              'You.com'],
  [/(^|\.)poe\.com$/i,                              'Poe'],
  [/(^|\.)phind\.com$/i,                            'Phind'],
  [/(^|\.)grok\.com$|(^|\.)x\.ai$/i,                'Grok'],
  [/(^|\.)mistral\.ai$|(^|\.)chat\.mistral\.ai$/i,  'Mistral'],
];
function aiReferral(referrer, utmSource) {
  let host = '';
  try { host = new URL(String(referrer || '')).hostname.toLowerCase(); } catch {}
  if (host) for (const [re, engine] of AI_REFS) if (re.test(host)) return engine;
  const u = String(utmSource || '').toLowerCase();
  if (u) for (const [re, engine] of AI_REFS) if (re.test(u.replace(/^https?:\/\//, ''))) return engine;
  return null;
}
// Records one AEO signal. Never throws — measurement must never break serving.
async function noteAi(env, slug, engine, kind) {
  if (!slug || !engine || !kind) return;
  const day = new Date().toISOString().slice(0, 10);
  try {
    await env.DB.prepare(
      `INSERT INTO ai_visits (slug, day, engine, kind, n) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(slug, day, engine, kind) DO UPDATE SET n = n + 1`
    ).bind(slug, day, engine, kind).run();
  } catch { /* never break a page render over a counter */ }
}

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

  // 📣 ADS SELF-SERVE (8/19/2026): Intake 1 asks whether they also want the
  // Google Ads landing page and/or ads management. Before this, that answer sat
  // buried in the intake and someone had to notice it. Now ticking the box puts
  // them on the Ads board already enrolled, with the fees recorded, the moment
  // the form lands.
  if (clientId) {
    const addons = String(lower['add-ons'] || lower['addons'] || lower['add ons'] || lower['add-on'] || '').toLowerCase();
    if (addons) {
      const wantsAds = /google ads?\b|ads management/.test(addons);
      const wantsLp = /landing page/.test(addons);
      if (wantsAds || wantsLp) {
        const settingsI = await getSettings(db);
        let repI = {}; try { repI = JSON.parse(settingsI['ads_' + clientId] || '{}'); } catch {}
        const cli = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
        const bizI = (cli && (cli.business_name || cli.name || cli.email)) || 'this client';
        const parts = [];
        if (wantsAds && !repI.track) {
          repI.track = 'addon'; repI.monthly = 249;
          repI.enrolled_at = repI.enrolled_at || new Date().toISOString();
          repI.source = 'intake';
          parts.push('Google Ads management $249/mo');
        }
        if (wantsLp && !repI.lp_fee) { repI.lp_fee = 300; parts.push('landing page $300 one-time'); }
        if (parts.length) {
          await setSetting(db, 'ads_' + clientId, JSON.stringify(repI));
          await logEvent(db, clientId, 'ads_enrolled',
            `\u{1F4E3} ${bizI} asked for ${parts.join(' + ')} in Intake ${n} — already on the Ads board. Next: build their landing page, then paste it and hit Set it all up.`);
          await notifyOwner(c.env, settingsI, `\u{1F4E3} ${bizI} wants ads`,
            `<p><b>${bizI}</b> ticked <b>${parts.join('</b> and <b>')}</b> in Intake ${n}.</p>` +
            `<p>They are already enrolled on the Ads board. Their first ads step is yours: build the GoHighLevel landing page, paste it on the Ads tab, and press <b>Set it all up</b>.</p>` +
            `<p><a href="${BASE_URL}">Open Mission Control</a></p>`);
        }
      }
    }
  }

  // 📦 PACKAGE SELF-SERVE (Tiffany 8/17): the client picks Standard or Premium
  // inside Intake 2, so the tier lands on their card automatically and the agreement
  // chain below can fire with the RIGHT package instead of pausing for her hands.
  // Her manual tier control on the dashboard still works and still wins if she changes it.
  if (n === 2 && clientId) {
    const pkgRaw = String(lower['package'] || '').toLowerCase();
    if (pkgRaw.includes('premium') || pkgRaw.includes('standard')) {
      const pick = pkgRaw.includes('premium') ? 'premium' : 'standard';
      await touchClient(db, clientId, { tier: pick });
      await logEvent(db, clientId, 'tier_set', `📦 Client chose the ${pick === 'premium' ? 'Premium $999' : 'Standard $649'} package in Intake 2`);
    }
  }

  // ⛓ CHAIN (Tiffany 7/27): Intake 2 submitted → the agreement goes out IMMEDIATELY
  // (unless already signed or already sent). Signature then auto-fires the deposit invoice.
  if (n === 2 && clientId) {
    const chain = (async () => {
      try {
        const cl = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
        if (!cl || !cl.email) return;
        const signed = await db.prepare('SELECT id FROM agreements WHERE client_id = ? LIMIT 1').bind(clientId).first();
        if (signed) return;
        const bC = getBilling(cl);
                if (bC.agr_sent) return; // already out — the nudges chase it
        const settingsC = await getSettings(db);
        if (!c.env.GHL_TOKEN || !settingsC.ghl_location_id) return;
        // 8/17 TIER GATE: never auto-send a contract before the package is chosen. The
        // agreement prints the package from client.tier and silently defaults to
        // Standard $649 when tier is empty (this already bit one premium client).
        if (cl.tier !== 'premium' && cl.tier !== 'standard') {
          await logEvent(db, clientId, 'error', `⚠ Agreement NOT auto-sent — no package set on the card. Pick Standard or Premium on the client card, then hit Resend agreement.`);
          try {
            if (settingsC.notify_email) {
              const ghlN = ghlFor(c.env, settingsC);
              const contactN = await ghlN.upsertContact({ email: settingsC.notify_email, name: 'ConversionCo Notifications' });
              await ghlN.sendEmail({ contactId: contactN.id || contactN.contactId,
                subject: `⏸ Set the package for ${cl.business_name || cl.name || 'new client'} — agreement is waiting`,
                html: `<p>Intake 2 just landed for <b>${cl.business_name || cl.name || 'a client'}</b>, but no package (Standard or Premium) is set on their card, so the agreement was NOT sent — it would have printed Standard $649 by default.</p><p>Open Mission Control, set the tier on their card, then hit <b>Resend agreement</b>.</p>`,
                emailFrom: settingsC.email_from || undefined });
            }
          } catch { /* the log line above is the guarantee; email is best-effort */ }
          return;
        }
        const url = `${BASE_URL}/agreement/${clientId}/${await portalToken(c.env, 'agr', clientId)}`;
        const biz = cl.business_name || cl.name || 'your business';
        const ghl = ghlFor(c.env, settingsC);
        const contact = await ghl.upsertContact({ email: cl.email, name: cl.name || '' });
        await ghl.sendEmail({ contactId: contact.id || contact.contactId,
          subject: `One quick signature before we begin — ${biz}`,
          html: `<p>Hi ${(cl.name || '').split(' ')[0] || 'there'},</p>
<p>Your vision form just landed — thank you, it's exactly what the design team needs. One quick signature and we're officially building: our service agreement is plain English, about two minutes to read, and it protects both of us. The short version: your domain and your website are yours.</p>
<p><a href="${url}">${url}</a></p>
<p>Your invoice arrives right after you sign, and the build starts the moment it's settled. Questions about anything in it? Just reply.</p>
<p>Talk soon,<br>The ConversionCo Team</p>`,
          emailFrom: settingsC.email_from || undefined });
        bC.agr_sent = new Date().toISOString();
        await touchClient(db, clientId, { billing: JSON.stringify(bC) });
        await logEvent(db, clientId, 'agreement_sent', `⛓ Intake 2 received — agreement sent automatically to ${cl.email}`);
      } catch (e) { await logEvent(db, clientId, 'error', `Auto-agreement after Intake 2 failed: ${String(e.message).slice(0, 140)}`); }
    })();
    c.executionCtx.waitUntil(chain);
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
  // 📊 first-party visitor counting — real page views only: HTML documents, not bots,
  // not the portal's own mini-preview iframe, not assets
  try {
    const ua = c.req.header('User-Agent') || '';
    const isHtml = String(row.content_type || '').includes('text/html');
    const isBot = /bot|crawl|spider|slurp|headless|preview|monitor|lighthouse|pingdom/i.test(ua) || !ua;
    const isFrame = (c.req.header('Sec-Fetch-Dest') || '') === 'iframe';
    // Tiffany's own peeks are NOT visitors — an admin session never counts.
    // ?nocount=1 lets QA/tests view without polluting the numbers.
    const isAdmin = await checkSession(c.env, c.req.header('Cookie'));
    const noCount = !!c.req.query('nocount');
    // AEO signals are measured before the bot/admin filters — an AI agent fetching
    // the page IS the signal, and it would otherwise be discarded as a crawler.
    if (isHtml && !noCount) {
      const ag = aiAgent(ua);
      if (ag) c.executionCtx.waitUntil(noteAi(c.env, slug, ag.engine, ag.kind));
      else if (!isAdmin) {
        const ref = aiReferral(c.req.header('Referer'), c.req.query('utm_source'));
        if (ref) c.executionCtx.waitUntil(noteAi(c.env, slug, ref, 'referral'));
      }
    }
    if (isHtml && !isBot && !isFrame && !isAdmin && !noCount) {
      const day = new Date().toISOString().slice(0, 10);
      c.executionCtx.waitUntil(c.env.DB.prepare(
        `INSERT INTO hits (slug, day, path, n) VALUES (?, ?, ?, 1)
         ON CONFLICT(slug, day, path) DO UPDATE SET n = n + 1`
      ).bind(slug, day, path).run().catch(() => {}));
    }
  } catch { /* counting must never break serving */ }
  const body = row.is_base64 ? Uint8Array.from(atob(row.content), (ch) => ch.charCodeAt(0)) : row.content;
  return new Response(body, { headers: { 'Content-Type': row.content_type, 'Cache-Control': 'no-cache' } });
});

// Keyed: wipe visit counts for a slug (test pollution cleanup) — true data only
app.get('/api/clear-hits/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const slug = String(c.req.query('slug') || '');
  if (!slug) return c.json({ ok: false, error: 'slug required' });
  const r = await c.env.DB.prepare('DELETE FROM hits WHERE slug = ?').bind(slug).run();
  return c.json({ ok: true, slug, deleted: r.meta ? r.meta.changes : 0 });
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

// 8/17 Keyed: retire a slug from the SERVED copy (D1 site_files + watcher state).
// Full retirement order: delete the folder from the GitHub repo FIRST (otherwise the
// next auto-publish tick just re-imports it), then call this endpoint.
app.get('/api/delete-site/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const db = c.env.DB;
  const slug = String(c.req.query('slug') || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(slug)) return c.json({ error: 'bad slug' }, 400);
  const KEEP = ['anywhere-infusions', 'anywhere-infusions-v3', 'template-999-premium', 'deboer-iv', 'glow', 'ivy-portal', 'lp-250-template'];
  if (KEEP.includes(slug) && c.req.query('force') !== 'yes')
    return c.json({ error: 'protected slug — add &force=yes only if you are absolutely sure' }, 400);
  const row = await db.prepare('SELECT COUNT(*) AS n FROM site_files WHERE slug = ?').bind(slug).first();
  await db.prepare('DELETE FROM site_files WHERE slug = ?').bind(slug).run();
  await setSetting(db, `site_sha_${slug}`, '');
  await setSetting(db, `editpending_${slug}`, '');
  await setSetting(db, `editwatch_${slug}`, '');
  await logEvent(db, null, 'site_deleted', `🗑 ${slug} retired from the served copy (${(row && row.n) || 0} file(s) removed); repo cleanup handled separately`);
  return c.json({ ok: true, slug, removed: (row && row.n) || 0 });
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
    // which-drip quiz taps per site (market demand signal for the copy retro)
    quiz: await (async () => {
      const rows = (await c.env.DB.prepare(`SELECT key, value FROM settings WHERE key LIKE 'qz_%'`).all()).results || [];
      const out = {};
      for (const r of rows) { try { out[r.key.slice(3)] = JSON.parse(r.value); } catch {} }
      return out;
    })(),
    tiers: await (async () => {
      const rows = (await c.env.DB.prepare('SELECT id, email, business_name, tier, stage, billing, competitors, live_url FROM clients').all()).results || [];
      const out = [];
      for (const r of rows) {
        let b = {}; try { b = JSON.parse(r.billing || '{}'); } catch {}
        out.push({ id: r.id, email: r.email, business_name: r.business_name, tier: r.tier, stage: r.stage,
          paid: depositPaid(b), paidInFull: finalPaid(b), hosting: b.sub_status === 'active',
          competitors: r.competitors || '', live_url: r.live_url || '',
          gbp_url: `${BASE_URL}/gbp/${r.id}/${await portalToken(c.env, 'gbp', r.id)}` });
      }
      return out;
    })(),
    revisionQueue: await (async () => {
      const rows = (await c.env.DB.prepare(`SELECT r.*, cl.business_name, cl.tier, cl.email FROM revisions r JOIN clients cl ON cl.id = r.client_id WHERE r.status = 'pending' ORDER BY r.id`).all()).results || [];
      return rows;
    })(),
    buildQueue: await (async () => {
      const rows = (await c.env.DB.prepare(`SELECT * FROM clients WHERE stage IN ('intake2_done','generating')`).all()).results || [];
      const out = [];
      for (const r of rows) {
        let b = {}; try { b = JSON.parse(r.billing || '{}'); } catch {}
        // ingredients the builder's completeness gate checks before cooking
        const ph = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM site_files WHERE slug=? AND path LIKE 'photo-%'`).bind(`_assets-${r.id}`).first())?.n || 0;
        const lg = await c.env.DB.prepare(`SELECT 1 AS x FROM site_files WHERE slug=? AND path='logo'`).bind(`_assets-${r.id}`).first();
        out.push({ id: r.id, email: r.email, name: r.name, business_name: r.business_name,
          tier: r.tier || 'standard', theme: r.theme || '', vibe: r.vibe || '', vertical: r.vertical || 'iv-therapy',
          paid: depositPaid(b), photos: ph, hasLogo: !!lg,
          intake1: r.intake1_data || '', intake2: r.intake2_data || '' });
      }
      return out;
    })(),
    demoQueue: await (async () => {
      const rows = (await c.env.DB.prepare(`SELECT * FROM clients WHERE stage = 'prospect'`).all()).results || [];
      const out = [];
      for (const r of rows) {
        out.push({ id: r.id, business_name: r.business_name, name: r.name,
          theme: r.theme || '', vibe: r.vibe || '', vertical: r.vertical || 'iv-therapy',
          intake1: r.intake1_data || '',
          pitch_url: `${BASE_URL}/pitch/${r.id}/${await portalToken(c.env, 'pitch', r.id)}` });
      }
      return out;
    })(),
    clientLeads: await (async () => {
      // recent lead messages + sources per client — feeds the FAQ-that-learns and
      // lead-source sections of the report engines
      // excludes the client's own portal messages — those are not visitor leads
      const rows = (await c.env.DB.prepare(`SELECT client_id, name, message, source, created_at FROM leads WHERE created_at > datetime('now','-35 days') AND slug != 'portal-message' ORDER BY id DESC LIMIT 200`).all()).results || [];
      const out = {};
      for (const l of rows) {
        if (!l.client_id) continue;
        (out[l.client_id] = out[l.client_id] || []).push({ name: l.name, message: (l.message || '').slice(0, 300), source: l.source || 'direct', at: l.created_at });
      }
      return out;
    })(),
    counters: await (async () => {
      const rows = (await c.env.DB.prepare('SELECT id FROM clients').all()).results || [];
      const out = {};
      for (const r of rows) {
        // leads NEVER include the client's own portal messages (true-data law)
        const l = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM leads WHERE client_id = ? AND slug != 'portal-message'`).bind(r.id).first())?.n || 0;
        const v = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM revisions WHERE client_id = ? AND status='done'`).bind(r.id).first())?.n || 0;
        const bk = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM leads WHERE client_id = ? AND status='booked' AND slug != 'portal-message'`).bind(r.id).first())?.n || 0;
        out[r.id] = { leads: l, revisionsDone: v, booked: bk };
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
    visits: await (async () => {
      // First-party visitor counts from the hits table (bot-filtered, iframe-
      // excluded, admin sessions never counted). TRUE-DATA GATE: a slug only
      // appears here when its client is GENUINELY live (live_url set) — preview
      // traffic before launch is internal and must never reach a report.
      // ext-<id> entries come from the pixel on an already-live external site.
      const out = {};
      try {
        // slug → live client map
        const metasV = (await c.env.DB.prepare(`SELECT slug, content FROM site_files WHERE path='site-meta.json'`).all()).results || [];
        const clientsV = (await c.env.DB.prepare(`SELECT id, live_url FROM clients`).all()).results || [];
        const liveIds = new Set(clientsV.filter((x) => x.live_url).map((x) => x.id));
        const liveSlugs = new Set();
        for (const m of metasV) { try { const cid = JSON.parse(m.content).client_id; if (liveIds.has(cid)) liveSlugs.add(m.slug); } catch {} }
        const rows = (await c.env.DB.prepare(`SELECT slug, day, path, n FROM hits WHERE day > date('now','-28 days')`).all()).results || [];
        for (const h of rows) {
          if (!h.slug.startsWith('ext-') && !liveSlugs.has(h.slug)) continue;
          const o = (out[h.slug] = out[h.slug] || { week: 0, month: 0, pages: {} });
          o.month += h.n;
          if (h.day > new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)) o.week += h.n;
          o.pages[h.path] = (o.pages[h.path] || 0) + h.n;
        }
        for (const s of Object.keys(out)) {
          const top = Object.entries(out[s].pages).filter(([p]) => p !== 'index.html' && p !== '').sort((a, b) => b[1] - a[1])[0];
          out[s].top = top ? top[0] : '';
          delete out[s].pages;
        }
      } catch {}
      return out;
    })(),
    gsc: await (async () => {
      // Google Search Console: configured flag + per-client state and the latest
      // exact-numbers snapshot (gsc_data_<id>) — report engines PREFER this data.
      const rows = (await c.env.DB.prepare(`SELECT key, value FROM settings WHERE key LIKE 'gsc%'`).all()).results || [];
      const out = { configured: gscConfigured(c.env) };
      for (const r of rows) { try { out[r.key] = JSON.parse(r.value); } catch {} }
      return out;
    })(),
  });
});

// ---- Keyed file commit → client-sites repo via the worker's own GitHub token ----
// Two modes: {path, message, b64} writes full content; {path, message, replaces:
// [[find, replaceWith], ...]} patches the existing file (each find must match).
app.post('/api/commit-file/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  if (!c.env.GITHUB_TOKEN) return c.json({ ok: false, error: 'GITHUB_TOKEN secret not set' });
  let f = {}; try { f = await c.req.json(); } catch {}
  const path = String(f.path || '');
  const message = String(f.message || '');
  if (!path || !message) return c.json({ ok: false, error: 'path + message required' }, 400);
  const settings = await getSettings(c.env.DB);
  const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
  const ghHeaders = { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' };
  const api = `https://api.github.com/repos/${repo}/contents/${path}`;
  const getRes = await fetch(api, { headers: ghHeaders });
  const existing = getRes.ok ? await getRes.json() : null;
  let content = String(f.b64 || '');
  if (!content && Array.isArray(f.replaces)) {
    if (!existing || !existing.content) return c.json({ ok: false, error: 'file not found for replace mode' }, 404);
    let text = new TextDecoder().decode(Uint8Array.from(atob(String(existing.content).replace(/\n/g, '')), (ch) => ch.charCodeAt(0)));
    for (const pair of f.replaces) {
      const find = String(pair[0] || ''); const repl = String(pair[1] || '');
      if (!find || !text.includes(find)) return c.json({ ok: false, error: 'target text not found: ' + find.slice(0, 80) }, 400);
      text = text.split(find).join(repl);
    }
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    content = btoa(bin);
  }
  if (!content) return c.json({ ok: false, error: 'b64 or replaces required' }, 400);
  const putRes = await fetch(api, { method: 'PUT', headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content, ...(existing && existing.sha ? { sha: existing.sha } : {}) }) });
  const out = await putRes.json();
  if (!putRes.ok) return c.json({ ok: false, error: JSON.stringify(out).slice(0, 300) });
  return c.json({ ok: true, commit: (out.commit && out.commit.sha || '').slice(0, 10), path });
});

// ---- GET-based chunked commit lane (scheduled Claude sessions: WebFetch is GET-only) ----
// Upload: /api/gcommit/<key>?id=<file-id>&part=<i>&of=<n>&data=<b64url chunk, URL-encoded>
// The FINAL part (part == of) must also carry &path=<enc repo path>&msg=<enc commit message>.
// Worker assembles the parts in order, commits via the GitHub contents API (3 retries),
// then deletes the chunk rows. Single small file: part=1&of=1 with data+path+msg together.
// data accepts base64url (- and _ for + and /); stray spaces are restored to +.
app.get('/api/gcommit/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  if (!c.env.GITHUB_TOKEN) return c.json({ ok: false, error: 'GITHUB_TOKEN secret not set' });
  const db = c.env.DB;
  const id = String(c.req.query('id') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  const part = Number(c.req.query('part'));
  const of = Number(c.req.query('of'));
  const data = String(c.req.query('data') || '').replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
  if (!id || !part || !of || part < 1 || part > of || of > 400) return c.json({ ok: false, error: 'id, part, of required (of <= 400)' }, 400);
  if (data) await setSetting(db, 'gchunk_' + id + '_' + part, data);
  if (part !== of) return c.json({ ok: true, stored: part, of });
  const rows = (await db.prepare('SELECT key, value FROM settings WHERE key LIKE ?').bind('gchunk_' + id + '_%').all()).results || [];
  const parts = {};
  for (const r of rows) parts[Number(r.key.slice(('gchunk_' + id + '_').length))] = r.value;
  let full = '';
  for (let i = 1; i <= of; i++) {
    if (!(i in parts)) return c.json({ ok: false, error: 'missing part ' + i + ' - resend it, then re-call the final part' });
    full += parts[i];
  }
  const path = String(c.req.query('path') || '');
  const message = String(c.req.query('msg') || '');
  if (!path || !message) return c.json({ ok: false, error: 'path + msg required on the final part' }, 400);
  const settings = await getSettings(db);
  const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
  const ghHeaders = { Authorization: 'Bearer ' + c.env.GITHUB_TOKEN, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' };
  const api = 'https://api.github.com/repos/' + repo + '/contents/' + path;
  let out = null, okFlag = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const getRes = await fetch(api, { headers: ghHeaders });
    const existing = getRes.ok ? await getRes.json() : null;
    const putRes = await fetch(api, { method: 'PUT', headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content: full, ...(existing && existing.sha ? { sha: existing.sha } : {}) }) });
    out = await putRes.json();
    if (putRes.ok) { okFlag = true; break; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  for (let i = 1; i <= of; i++) await db.prepare('DELETE FROM settings WHERE key = ?').bind('gchunk_' + id + '_' + i).run();
  if (!okFlag) return c.json({ ok: false, error: JSON.stringify(out).slice(0, 300) });
  await logEvent(db, null, 'gcommit', 'GET-lane commit ' + ((out.commit && out.commit.sha) || '').slice(0, 10) + ' ' + path);
  return c.json({ ok: true, commit: ((out.commit && out.commit.sha) || '').slice(0, 10), path });
});
 
// ---- GET-based repo read lane (scheduled sessions can no longer git clone) ----
// /api/gread/<key>?path=<repo path>            → raw file text (up to ~1MB)
// /api/gread/<key>?path=<repo path>&b64=1      → base64 of the bytes (for binary files)
// /api/gread/<key>?dir=<repo directory path>   → JSON list of {name, path, size, type}
app.get('/api/gread/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  if (!c.env.GITHUB_TOKEN) return c.json({ ok: false, error: 'GITHUB_TOKEN secret not set' });
  const settings = await getSettings(c.env.DB);
  const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
  const ghHeaders = { Authorization: 'Bearer ' + c.env.GITHUB_TOKEN, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' };
  const dir = String(c.req.query('dir') || '');
  const path = String(c.req.query('path') || '');
  if (!dir && !path) return c.json({ ok: false, error: 'path or dir required' }, 400);
  const target = dir || path;
  const res = await fetch('https://api.github.com/repos/' + repo + '/contents/' + target, { headers: ghHeaders });
  if (!res.ok) return c.json({ ok: false, error: 'GitHub ' + res.status + ' for ' + target }, 404);
  const j = await res.json();
  if (Array.isArray(j)) return c.json(j.map((e) => ({ name: e.name, path: e.path, size: e.size, type: e.type })));
  const b64 = String(j.content || '').replace(/\n/g, '');
  if (c.req.query('b64')) return c.text(b64);
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return c.text(new TextDecoder().decode(bytes));
});

// ---- Server-side repo file COPY (images/binaries never pass through the AI) ----
// /api/gcopy/<key>?from=<repo path>&to=<repo path>&msg=<enc commit message>
// Reads the source blob via the GitHub contents API and PUTs it at the new path.
app.get('/api/gcopy/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  if (!c.env.GITHUB_TOKEN) return c.json({ ok: false, error: 'GITHUB_TOKEN secret not set' });
  const from = String(c.req.query('from') || '');
  const to = String(c.req.query('to') || '');
  const message = String(c.req.query('msg') || ('copy ' + from + ' -> ' + to));
  if (!from || !to) return c.json({ ok: false, error: 'from + to required' }, 400);
  const settings = await getSettings(c.env.DB);
  const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
  const ghHeaders = { Authorization: 'Bearer ' + c.env.GITHUB_TOKEN, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' };
  const srcRes = await fetch('https://api.github.com/repos/' + repo + '/contents/' + from, { headers: ghHeaders });
  if (!srcRes.ok) return c.json({ ok: false, error: 'source not found: ' + from + ' (' + srcRes.status + ')' }, 404);
  const src = await srcRes.json();
  let content = String(src.content || '').replace(/\n/g, '');
  if (!content && src.git_url) {
    const blobRes = await fetch(src.git_url, { headers: ghHeaders });
    if (blobRes.ok) { const blob = await blobRes.json(); content = String(blob.content || '').replace(/\n/g, ''); }
  }
  if (!content) return c.json({ ok: false, error: 'could not read source blob' });
  const destApi = 'https://api.github.com/repos/' + repo + '/contents/' + to;
  const destRes = await fetch(destApi, { headers: ghHeaders });
  const existing = destRes.ok ? await destRes.json() : null;
  let out = null, okFlag = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const putRes = await fetch(destApi, { method: 'PUT', headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content, ...(existing && existing.sha ? { sha: existing.sha } : {}) }) });
    out = await putRes.json();
    if (putRes.ok) { okFlag = true; break; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!okFlag) return c.json({ ok: false, error: JSON.stringify(out).slice(0, 300) });
  return c.json({ ok: true, commit: ((out.commit && out.commit.sha) || '').slice(0, 10), from, to, bytes: src.size || 0 });
});
 
// ---- Sliced repo reads (safe for big files; plain gread may truncate in transit) ----
// /api/gread2/<key>?path=<repo path>&stat=1            → {size, sha} only
// /api/gread2/<key>?path=<repo path>&start=<n>&len=<n> → exact byte slice as text
//   (add &b64=1 to get the slice base64-encoded instead — for binary checks)
app.get('/api/gread2/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  if (!c.env.GITHUB_TOKEN) return c.json({ ok: false, error: 'GITHUB_TOKEN secret not set' });
  const path = String(c.req.query('path') || '');
  if (!path) return c.json({ ok: false, error: 'path required' }, 400);
  const settings = await getSettings(c.env.DB);
  const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
  const ghHeaders = { Authorization: 'Bearer ' + c.env.GITHUB_TOKEN, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' };
  const res = await fetch('https://api.github.com/repos/' + repo + '/contents/' + path, { headers: ghHeaders });
  if (!res.ok) return c.json({ ok: false, error: 'GitHub ' + res.status + ' for ' + path }, 404);
  const j = await res.json();
  let content = String(j.content || '').replace(/\n/g, '');
  if (!content && j.git_url) {
    const blobRes = await fetch(j.git_url, { headers: ghHeaders });
    if (blobRes.ok) { const blob = await blobRes.json(); content = String(blob.content || '').replace(/\n/g, ''); }
  }
  const bytes = Uint8Array.from(atob(content), (ch) => ch.charCodeAt(0));
  if (c.req.query('stat')) return c.json({ ok: true, path, size: bytes.length, sha: j.sha });
  const start = Math.max(0, Number(c.req.query('start')) || 0);
  const len = Math.min(200000, Number(c.req.query('len')) || 8000);
  const slice = bytes.subarray(start, start + len);
  if (c.req.query('b64')) {
    let bin = '';
    for (let i = 0; i < slice.length; i += 8192) bin += String.fromCharCode.apply(null, slice.subarray(i, i + 8192));
    return c.text(btoa(bin));
  }
  return c.text(new TextDecoder().decode(slice));
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
    // slug 'library' targets the shared image library instead of a client site.
    // Respect an extension the caller already provided (jpg/webp/etc); default .png.
    const extMatch = name.match(/\.(png|jpe?g|webp|gif|svg)$/i);
    const fname = extMatch ? name : `${name}.png`;
    const fmime = extMatch ? (MIME[extMatch[1].toLowerCase() === 'jpg' ? 'jpg' : extMatch[1].toLowerCase()] || 'image/png') : 'image/png';
    const path = slug === 'library' ? `library/img/${fname}` : `sites/${slug}/img/${fname}`;
    const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' },
    });
    const existing = getRes.ok ? await getRes.json() : null;
    const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Add ${fname}`, content: b64, ...(existing?.sha ? { sha: existing.sha } : {}) }),
    });
    if (!putRes.ok) return c.json({ ok: false, error: `GitHub ${putRes.status}` });
    await c.env.DB.prepare(
      `INSERT INTO site_files (slug, path, content, content_type, is_base64, updated_at)
       VALUES (?, ?, ?, ?, 1, datetime('now'))
       ON CONFLICT(slug, path) DO UPDATE SET content=excluded.content, is_base64=1, updated_at=datetime('now')`
    ).bind(slug, `img/${fname}`, b64, fmime).run();
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
  // accepts JSON or a plain form POST (form navigation is the only route past
  // some pages' CSP — e.g. pushing a generated image out of the ChatGPT tab)
  let f = {};
  try { f = await c.req.json(); } catch { try { f = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)])); } catch {} }
  const { b64, slug, name: rawName, ext = 'png' } = f;
  if (!b64 || !slug || !rawName) return c.json({ ok: false, error: 'b64, slug, name required' }, 400);
  if (b64.length > 11_000_000) return c.json({ ok: false, error: 'image too large' });
  const clean = b64.replace(/^data:[^,]+,/, '');
  // A name that already carries an extension WINS (callers send "photo.jpg");
  // otherwise the ext field (default png). Never produce name.jpg.png again.
  const nameExtM = String(rawName).match(/\.(png|jpe?g|webp)$/i);
  const name = nameExtM ? String(rawName).replace(/\.(png|jpe?g|webp)$/i, '') : String(rawName);
  const extEff = nameExtM ? (nameExtM[1].toLowerCase() === 'jpeg' ? 'jpg' : nameExtM[1].toLowerCase()) : ext;
  const safeExt = extEff === 'webp' ? 'webp' : extEff === 'jpg' ? 'jpg' : 'png';
  const mime = safeExt === 'webp' ? 'image/webp' : safeExt === 'jpg' ? 'image/jpeg' : 'image/png';
  const settings = await getSettings(c.env.DB);
  const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
  try {
    // slug 'library' targets the shared image library instead of a client site
    const path = slug === 'library' ? `library/img/${name}.${safeExt}` : `sites/${slug}/img/${name}.${safeExt}`;
    const ghHeaders = { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' };
    const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, { headers: ghHeaders });
    const existing = getRes.ok ? await getRes.json() : null;
    const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Add ${name}.${safeExt}`, content: clean, ...(existing?.sha ? { sha: existing.sha } : {}) }),
    });
    if (!putRes.ok) return c.json({ ok: false, error: `GitHub ${putRes.status}: ${(await putRes.text()).slice(0, 200)}` });
    // D1 preview mirror: client sites only, and only when it fits D1's value cap.
    // Library images live in the repo alone — builders copy them at build time.
    let mirrored = false;
    if (slug !== 'library' && clean.length < 1_800_000) {
      try {
        await c.env.DB.prepare(
          `INSERT INTO site_files (slug, path, content, content_type, is_base64, updated_at)
           VALUES (?, ?, ?, ?, 1, datetime('now'))
           ON CONFLICT(slug, path) DO UPDATE SET content=excluded.content, content_type=excluded.content_type, is_base64=1, updated_at=datetime('now')`
        ).bind(slug, `img/${name}.${safeExt}`, clean, mime).run();
        mirrored = true;
      } catch { /* repo copy is canonical; preview refreshes on next auto-publish */ }
    }
    return c.json({ ok: true, bytes: Math.floor(clean.length * 0.75), path, mirrored, preview: slug === 'library' ? null : `${BASE_URL}/preview/${slug}/img/${name}.${safeExt}` });
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


// Keyed text-file reader from the sites repo (GET, WebFetch-able) — lets the
// builder read catalog.json / site-metas when its sandbox can't reach GitHub.
app.get('/api/readfile/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  if (!c.env.GITHUB_TOKEN) return c.json({ ok: false, error: 'GITHUB_TOKEN secret not set' });
  const path = String(c.req.query('path') || '');
  if (!path) return c.json({ ok: false, error: 'path required' }, 400);
  const settings = await getSettings(c.env.DB);
  const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
  const ghHeaders = { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' };
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, { headers: ghHeaders });
  if (!r.ok) return c.json({ ok: false, error: `not found: ${path}` }, 404);
  const j = await r.json();
  if (Array.isArray(j)) return c.json({ ok: true, dir: j.map((f) => ({ name: f.name, type: f.type, size: f.size })) });
  let content = String(j.content || '');
  if (!content && j.sha) { // >1MB → blob API
    const b = await fetch(`https://api.github.com/repos/${repo}/git/blobs/${j.sha}`, { headers: ghHeaders });
    if (b.ok) content = String((await b.json()).content || '');
  }
  const text = new TextDecoder().decode(Uint8Array.from(atob(content.replace(/\n/g, '')), (ch) => ch.charCodeAt(0)));
  return c.text(text.slice(0, 200000));
});

// Keyed file DELETE from the sites repo (GET, WebFetch-able) — repo hygiene:
// removes stray/retired files so imports stay lean. Also cleans the D1 mirror.
app.get('/api/deletefile/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  if (!c.env.GITHUB_TOKEN) return c.json({ ok: false, error: 'GITHUB_TOKEN secret not set' });
  const path = String(c.req.query('path') || '');
  if (!path || path.includes('..')) return c.json({ ok: false, error: 'valid path required' }, 400);
  if (/site-meta\.json$|^tools\/|^reports\/_template\//.test(path)) return c.json({ ok: false, error: 'protected path' }, 400);
  const settings = await getSettings(c.env.DB);
  const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
  const ghHeaders = { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' };
  const meta = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, { headers: ghHeaders });
  if (!meta.ok) return c.json({ ok: false, error: `not found: ${path}` }, 404);
  const mj = await meta.json();
  const delRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'DELETE', headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `🧹 remove ${path}`, sha: mj.sha }) });
  if (!delRes.ok) { const out = await delRes.json().catch(() => ({}));
    return c.json({ ok: false, error: JSON.stringify(out).slice(0, 200) }); }
  const m2 = path.match(/^sites\/([^/]+)\/(.+)$/);
  if (m2) await c.env.DB.prepare('DELETE FROM site_files WHERE slug = ? AND path = ?').bind(m2[1], m2[2]).run();
  return c.json({ ok: true, deleted: path });
});

// Keyed server-side file copy WITHIN the sites repo (GET so it's WebFetch-able).
// Built for the builder: copy library images into a client's img/ folder without
// the bytes ever leaving GitHub. Handles >1MB files via the git blob API.
app.get('/api/copyfile/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  if (!c.env.GITHUB_TOKEN) return c.json({ ok: false, error: 'GITHUB_TOKEN secret not set' });
  const from = String(c.req.query('from') || ''); const to = String(c.req.query('to') || '');
  if (!from || !to) return c.json({ ok: false, error: 'from + to required' }, 400);
  const settings = await getSettings(c.env.DB);
  const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
  const ghHeaders = { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' };
  const meta = await fetch(`https://api.github.com/repos/${repo}/contents/${from}`, { headers: ghHeaders });
  if (!meta.ok) return c.json({ ok: false, error: `source not found: ${from}` }, 404);
  const mj = await meta.json();
  const blobRes = await fetch(`https://api.github.com/repos/${repo}/git/blobs/${mj.sha}`, { headers: ghHeaders });
  if (!blobRes.ok) return c.json({ ok: false, error: 'blob read failed' });
  const blob = await blobRes.json();
  const content = String(blob.content || '').replace(/\n/g, '');
  const destRes = await fetch(`https://api.github.com/repos/${repo}/contents/${to}`, { headers: ghHeaders });
  const dest = destRes.ok ? await destRes.json() : null;
  const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${to}`, {
    method: 'PUT', headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `copy ${from} → ${to}`, content, ...(dest && dest.sha ? { sha: dest.sha } : {}) }) });
  if (!putRes.ok) { const out = await putRes.json().catch(() => ({}));
    return c.json({ ok: false, error: JSON.stringify(out).slice(0, 200) }); }
  return c.json({ ok: true, to, bytes: mj.size });
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

// Shared: send a personal-style email to a client (moments engine)
async function emailClient(env, db, client, settings, subject, html, eventType, eventDetail) {
  if (!client?.email || !env.GHL_TOKEN || !settings.ghl_location_id) return false;
  try {
    const ghl = new GHL(env.GHL_TOKEN, settings.ghl_location_id);
    const contact = await ghl.upsertContact({ email: client.email, name: client.name || '' });
    await ghl.sendEmail({ contactId: contact.id || contact.contactId, subject, html, emailFrom: settings.email_from || undefined });
    if (eventType) await logEvent(db, client.id, eventType, eventDetail || subject);
    try { await db.prepare(`INSERT INTO email_log (client_id, to_email, subject, status, sent_at) VALUES (?, ?, ?, 'sent', datetime('now'))`)
      .bind(client.id || null, client.email, String(subject).slice(0, 200)).run(); } catch {}
    return true;
  } catch (e) {
    // record the failure WITH the html so the cron can retry it — silence is how clients get lost
    try { await db.prepare(`INSERT INTO email_log (client_id, to_email, subject, html, status, error) VALUES (?, ?, ?, ?, 'failed', ?)`)
      .bind(client.id || null, client.email, String(subject).slice(0, 200), String(html).slice(0, 60000), String(e && e.message || e).slice(0, 300)).run(); } catch {}
    try { await logEvent(db, client.id, 'email_failed', `📧⚠️ Email to ${client.email} failed ("${String(subject).slice(0, 60)}") — will retry automatically`); } catch {}
    return false;
  }
}

// Retry failed client emails (runs every 5 minutes; up to 4 total attempts each)
async function retryFailedEmails(env, settings) {
  const db = env.DB;
  if (!env.GHL_TOKEN || !settings.ghl_location_id) return;
  const rows = (await db.prepare(`SELECT * FROM email_log WHERE status = 'failed' AND attempts < 4 ORDER BY id LIMIT 5`).all()).results || [];
  for (const r of rows) {
    try {
      const ghl = new GHL(env.GHL_TOKEN, settings.ghl_location_id);
      const contact = await ghl.upsertContact({ email: r.to_email, name: '' });
      await ghl.sendEmail({ contactId: contact.id || contact.contactId, subject: r.subject, html: r.html, emailFrom: settings.email_from || undefined });
      await db.prepare(`UPDATE email_log SET status='sent', sent_at=datetime('now'), attempts=attempts+1, html='' WHERE id=?`).bind(r.id).run();
      await logEvent(db, r.client_id, 'email_retried', `📧✅ Delivered on retry: "${String(r.subject).slice(0, 70)}" to ${r.to_email}`);
    } catch (e) {
      const done = (r.attempts || 1) + 1 >= 4;
      await db.prepare(`UPDATE email_log SET attempts=attempts+1, error=?, status=? WHERE id=?`)
        .bind(String(e && e.message || e).slice(0, 300), done ? 'dead' : 'failed', r.id).run();
      if (done) await logEvent(db, r.client_id, 'email_failed', `📧⛔ Could not deliver after 4 tries: "${String(r.subject).slice(0, 70)}" to ${r.to_email} — needs a human look`);
    }
  }
}

// Fixed-window rate limit: true = allowed. Window resets every windowSec.
async function rlOk(db, key, max, windowSec) {
  try {
    const win = String(Math.floor(Date.now() / (windowSec * 1000)));
    const row = await db.prepare('SELECT n, win FROM ratelimit WHERE k = ?').bind(key).first();
    if (!row || row.win !== win) {
      await db.prepare(`INSERT INTO ratelimit (k, n, win) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n=1, win=excluded.win`).bind(key, win).run();
      return true;
    }
    if (row.n >= max) return false;
    await db.prepare('UPDATE ratelimit SET n = n + 1 WHERE k = ?').bind(key).run();
    return true;
  } catch { return true; /* never let the limiter break a real submission */ }
}

// Keyed: 🎉 Page 1 celebration — the engines call this the moment a keyword newly lands on Page 1
app.get('/api/celebrate/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const id = Number(c.req.query('id'));
  const kw = String(c.req.query('kw') || '').slice(0, 90);
  const pos = Number(c.req.query('pos')) || null;
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ ok: false, error: 'client not found' });
  const settings = await getSettings(db);
  const first = (client.name || '').split(' ')[0] || 'there';
  const url = `${BASE_URL}/portal/${id}/${await portalToken(c.env, 'portal', id)}`;
  const ok = await emailClient(c.env, db, client, settings,
    `You just hit Page 1 of Google 🎉`,
    `<p>${first} — stop what you're doing for a second.</p>
<p>When someone searches <b>"${kw}"</b>, your website is now on <b>Page 1 of Google${pos ? `, position #${pos}` : ''}</b>. That's not an ad — that's your site earning its spot.</p>
<p>See it live in your portal:</p><p><a href="${url}">${url}</a></p>
<p>Congratulations — this is what we've been building toward. More to come.</p>
<p>— The ConversionCo Team</p>`,
    'page1_celebrated', `🎉 Page 1 email sent: "${kw}"${pos ? ' #' + pos : ''}`);
  return c.json({ ok });
});

// Keyed: 📬 report-ready email — engines call after committing a report, with one highlight
app.get('/api/report-ready/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const id = Number(c.req.query('id'));
  const highlight = String(c.req.query('highlight') || '').slice(0, 160);
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ ok: false, error: 'client not found' });
  const settings = await getSettings(db);
  const first = (client.name || '').split(' ')[0] || 'there';
  const url = `${BASE_URL}/portal/${id}/${await portalToken(c.env, 'portal', id)}`;
  const ok = await emailClient(c.env, db, client, settings,
    `Your new report is in — one highlight inside`,
    `<p>Hi ${first},</p>
<p>Your latest report just landed in your portal. The highlight:</p>
<p style="font-size:17px;"><b>${highlight || 'Everything ran clean this period — details inside.'}</b></p>
<p>The full picture — your Google standing, your website's health, and everything we did for you — is one tap away:</p>
<p><a href="${url}">${url}</a></p>
<p>Questions? Just reply.</p><p>— The ConversionCo Team</p>`,
    'report_notified', `📬 Report-ready email sent${highlight ? ': ' + highlight.slice(0, 80) : ''}`);
  return c.json({ ok });
});

// Keyed: resend the agreement invite (same email the card button sends)
app.get('/api/send-agreement/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const id = Number(c.req.query('id'));
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client || !client.email) return c.json({ ok: false, error: 'client/email missing' });
  if (client.tier !== 'premium' && client.tier !== 'standard')
    return c.json({ ok: false, error: 'Set the package (Standard or Premium) on the card first — the contract prints the package from it.' });
  if (!client || !client.email) return c.json({ ok: false, error: 'client/email missing' });
if (client.tier !== 'premium' && client.tier !== 'standard') return c.json({ ok: false, error: 'Pick the package (standard or premium) on the client card first — the agreement price comes from it.' });
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

// Keyed test: run the after-call calendar poll's query once and report what it sees
app.get('/api/appt-test/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const settings = await getSettings(c.env.DB);
  if (!c.env.GHL_TOKEN || !settings.ghl_location_id) return c.json({ ok: false, error: 'GHL not configured' });
  const calId = settings.booking_calendar_id || 'kfZNB7wOmwHcy769nGh3';
  const now = Date.now();
  const url = new URL('https://services.leadconnectorhq.com/calendars/events');
  url.searchParams.set('locationId', settings.ghl_location_id);
  url.searchParams.set('calendarId', calId);
  url.searchParams.set('startTime', String(now - 7 * 24 * 3600 * 1000));
  url.searchParams.set('endTime', String(now + 7 * 24 * 3600 * 1000));
  const res = await fetch(url.toString(), { headers: {
    Authorization: `Bearer ${c.env.GHL_TOKEN}`, Version: '2021-04-15', Accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  const events = (body.events || body.data || []).map((ev) => ({
    id: ev.id || ev.eventId, start: ev.startTime, end: ev.endTime,
    status: ev.appointmentStatus || ev.status, contactId: ev.contactId || ev.contact_id,
    handled: Boolean(settings[`appt_done_${ev.id || ev.eventId}`]) }));
  return c.json({ ok: res.ok, status: res.status, calendar: calId, count: events.length, events: events.slice(0, 20),
    ...(res.ok ? {} : { error: JSON.stringify(body).slice(0, 300) }) });
});

// Keyed: clear stored email-template overrides so the code defaults (personal style) apply
app.get('/api/reset-templates/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const keys = ['intake1_subject', 'intake1_body', 'intake2_subject', 'intake2_body', 'booking_subject', 'booking_body'];
  for (const k of keys) await c.env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(k).run();
  return c.json({ ok: true, cleared: keys });
});

// Keyed: prove the Google connection works (called right after Tiffany pastes the secrets)
app.get('/api/gsc-test/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  if (!gscConfigured(c.env)) return c.json({ ok: false, configured: false, hint: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN not all set yet' });
  try {
    const { gscListProperties } = await import('./google.js');
    const props = await gscListProperties(c.env);
    return c.json({ ok: true, configured: true, properties: props });
  } catch (e) { return c.json({ ok: false, configured: true, error: String(e.message).slice(0, 300) }); }
});

// Keyed: prove the Kit wiring works WITHOUT anyone ever having to read the API
// key. Returns only booleans, counts and the account name — never the secret.
// ?email=someone@example.com does a real end-to-end subscribe against the
// configured form so a live test needs no dashboard login.
app.get('/api/kit-test/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const key = c.env.KIT_API_KEY;
  const settings = await getSettings(c.env.DB);
  const slug = (c.req.query('slug') || '').trim();
  const formId = String((slug && settings['kit_form_' + slug]) || settings.kit_form_id || '').replace(/\D/g, '');
  const out = { key_set: !!key, form_id: formId || null };
  if (!key) { out.hint = 'Add KIT_API_KEY as an encrypted Secret on the worker in Cloudflare.'; return c.json(out); }
  const hdrs = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kit-Api-Key': key };
  try {
    const me = await fetch('https://api.kit.com/v4/account', { headers: hdrs });
    out.key_valid = me.ok;
    out.account_status = me.status;
    if (me.ok) {
      const j = await me.json().catch(() => ({}));
      out.account = (j && j.account && (j.account.name || j.account.primary_email_address)) || null;
    }
  } catch (e) { out.key_valid = false; out.error = String(e.message).slice(0, 200); }
  const testEmail = String(c.req.query('email') || '').trim();
  if (out.key_valid && formId && testEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail)) {
    try {
      const r1 = await fetch('https://api.kit.com/v4/subscribers', { method: 'POST', headers: hdrs, body: JSON.stringify({ email_address: testEmail }) });
      out.create_status = r1.status;
      const r2 = await fetch('https://api.kit.com/v4/forms/' + formId + '/subscribers', { method: 'POST', headers: hdrs, body: JSON.stringify({ email_address: testEmail }) });
      out.attach_status = r2.status;
      out.subscribed = r1.ok && r2.ok;
      if (!r2.ok) out.attach_body = (await r2.text().catch(() => '')).slice(0, 200);
    } catch (e) { out.subscribe_error = String(e.message).slice(0, 200); }
  }
  return c.json(out);
});

// Keyed: enroll ANY domain in Search Console on demand (testing + Tiffany's own site).
// Tries Cloudflare auto-verify first; for domains with DNS elsewhere (e.g. Squarespace)
// it returns the TXT record to add manually, and re-calling after DNS propagates
// completes verification. Always finishes with a stats pull attempt.
app.get('/api/gsc-enroll/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  if (!gscConfigured(c.env)) return c.json({ ok: false, configured: false });
  const domain = (c.req.query('domain') || '').trim().toLowerCase().replace(/^www\./, '');
  if (!domain || !domain.includes('.')) return c.json({ ok: false, error: 'pass ?domain=example.com' });
  const out = { ok: true, domain };
  try { await gscAddProperty(c.env, domain); out.property = 'added'; }
  catch (e) { out.property = `error: ${String(e.message).slice(0, 160)}`; }
  try { await gscVerifyViaCloudflareDns(c.env, domain); out.verified = 'auto (Cloudflare DNS)'; }
  catch {
    // not a Cloudflare zone — manual DNS path
    try {
      out.txt_record = { host: '@', type: 'TXT', value: await gscGetDnsToken(c.env, domain) };
      try { await gscRequestVerify(c.env, domain); out.verified = true; }
      catch (e2) { out.verified = false; out.note = `Add the TXT record at the DNS host, wait a few minutes, then call this again. Google said: ${String(e2.message).slice(0, 160)}`; }
    } catch (e3) { out.verified = false; out.error = String(e3.message).slice(0, 200); }
  }
  try { out.stats = await gscQueryStats(c.env, domain, 28); } catch (e) { out.stats_error = String(e.message).slice(0, 160); }
  return c.json(out);
});

// Keyed: run the Sunday Search Console pull on demand (first-run / catch-up)
app.get('/api/gsc-now/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  if (!gscConfigured(c.env)) return c.json({ ok: false, configured: false });
  const settings = await getSettings(c.env.DB);
  await gscPullAll(c.env, settings);
  return c.json({ ok: true, ran: true });
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
const AGREEMENT_VERSION = 'v3-2026-08-19-notice-ads';
function agreementTerms(biz, pkgLabel, pkgPrice, opts) {
  const O = opts || {};
  const terms = [
    ['1. What we are building', `ConversionCo will design, write, and build the ${pkgLabel} for ${biz}: a custom, mobile-first website with full search-engine setup as described in your proposal. Your one-time project fee is ${pkgPrice}, paid in two equal halves: 50% as a deposit before the build begins, and the remaining 50% when your finished website preview is delivered to you.`],
    ['2. Website Care Plan — $99/month', `Your website stays live, protected, and fully looked after on the Website Care Plan. It covers your hosting, a complete backup of your entire website, and your own client portal where you can check your site's health, reports, and activity any time, along with security, daily uptime monitoring, and ongoing platform updates (Premium plans also include weekly published content). It is month-to-month and starts only when your site is ready and you confirm. You may cancel at any time by giving us 30 days' written notice — email counts. Your plan, and your billing, continue through that 30-day notice period and then stop; there is no charge after it.`],
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
  // Ads clauses only appear for clients who actually took the ads add-on, so a
  // website-only agreement never carries terms that do not apply to them.
  if (O.ads || O.landingPage) {
    if (O.landingPage) terms.push(['13. Landing page — $300 one-time', `Your Google Ads landing page is a separate page built specifically to convert ad traffic, for a one-time fee of $300. It includes the page itself, the tracking that measures calls, texts, forms and bookings, and one round of revisions. It is billed once, at the start.`]);
    if (O.ads) terms.push(['14. Google Ads management — $249/month', `We build and manage your Google Ads campaign: the account structure, keywords, negative keywords, ad copy, conversion tracking, and ongoing optimisation, with your results visible in your client portal. Your advertising budget is separate and is paid by you directly to Google — we never hold or bill your ad spend. Management is month-to-month and you may cancel at any time by giving us 30 days' written notice (email counts); management and billing continue through that notice period and then stop. On cancellation the Google Ads account remains yours, and we hand over access rather than keep it.`]);
    if (O.ads) terms.push(['15. What advertising can and cannot promise', `We will build and run your campaign to a documented standard and report honestly on what it produces. What we cannot do is guarantee a number of leads, customers, or a specific cost per lead — nobody can, because the auction, your competitors, and demand in your area all change week to week. Any figure we discuss in planning is an estimate of what would have to be true, not a promise of what will happen. You control your daily budget and can pause your campaign at any time.`]);
  }
  return terms;
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
  const settingsA = await getSettings(db);
  let repA = {}; try { repA = JSON.parse(settingsA['ads_' + id] || '{}'); } catch {}
  const terms = agreementTerms(biz, pkgLabel, pkgPrice, { ads: !!repA.track, landingPage: !!repA.lp_fee });
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
  <p class="sub">Between <b>ConversionCo</b> and <b>${biz}</b> · ${pkgLabel} · ${pkgPrice} + $99/mo Care Plan at launchch</p>
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
  // 🔒 DOUBLE-CLICK GUARD (caught live in the 8/17 pipeline test: two rapid sign
  // submissions raced past the billing guard and sent TWO deposit invoices). First
  // signature wins; any repeat returns ok and does nothing.
  const alreadySigned = await db.prepare('SELECT id FROM agreements WHERE client_id = ? LIMIT 1').bind(id).first();
  if (alreadySigned) return c.json({ ok: true, already: true });
  await db.prepare('INSERT INTO agreements (client_id, version, package, signed_name, user_agent) VALUES (?, ?, ?, ?, ?)')
    .bind(id, AGREEMENT_VERSION, pkg, name, (c.req.header('User-Agent') || '').slice(0, 200)).run();
  await logEvent(db, id, 'agreement_signed', `✍️ Agreement signed by ${name} (${pkg})`);
  const settings = await getSettings(db);
  // ⛓ CHAIN (Tiffany 7/27): the SECOND the signature lands, the 50% deposit
  // invoice fires — no manual step. Guards: Stripe configured, nothing already
  // sent/paid. Uses the card's current tier (set on the pricing call).
  try {
    const freshS = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
    const bS = getBilling(freshS || client);
    if (c.env.STRIPE_SECRET_KEY && !bS.dep_id && bS.dep_status !== 'paid' && bS.invoice_status !== 'paid' && !bS.fin_id) {
      const tierKeyS = (client.tier === 'premium') ? 'premium' : 'standard';
      const custS = await ensureCustomer(c.env.STRIPE_SECRET_KEY, client.email, client.name || client.business_name || '');
      const invS = await sendInvoice(c.env.STRIPE_SECRET_KEY, custS.id, tierKeyS, client.business_name || '', 'deposit');
      bS.customer_id = custS.id; bS.invoice_tier = tierKeyS;
      bS.dep_id = invS.id; bS.dep_status = invS.status; bS.dep_url = invS.url; bS.dep_created = new Date().toISOString();
      await touchClient(db, id, { billing: JSON.stringify(bS) });
      await logEvent(db, id, 'invoice_sent', `⛓ Signature landed — 50% deposit invoice auto-sent (${halfDisplay(tierKeyS)}) 💳`);
    }
  } catch (e) { await logEvent(db, id, 'error', `Auto-invoice after signature failed: ${String(e.message).slice(0, 140)} — send it manually from the card`); }
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
  // APPROVAL GATE: while the preview is held (built but Tiffany hasn't approved),
  // the portal must not reveal it — no link, no "preview ready" stage, no events.
  const previewHeld = client.stage === 'preview_ready' && billing.preview_hold && !billing.preview_approved;
  const HELD_TYPES = ['preview_ready', 'auto_published', 'revision_done', 'theme_changed'];
  const slug = await slugForClient(db, id);
  const blogs = slug ? ((await db.prepare(`SELECT path FROM site_files WHERE slug=? AND path LIKE 'blog-%' ORDER BY updated_at DESC LIMIT 5`).bind(slug).all()).results || []) : [];
  const leadsN = (await db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE client_id = ? AND slug != 'portal-message'`).bind(id).first())?.n || 0;
  const revsN = (await db.prepare(`SELECT COUNT(*) AS n FROM revisions WHERE client_id = ? AND status = 'done'`).bind(id).first())?.n || 0;
  const FRIENDLY = { auto_published: '🚀 Website updated & republished', revision_done: '✅ A requested change was completed',
    theme_changed: '🎨 Fresh look applied to your site', logo_uploaded: '🖼 Your logo was added', photo_uploaded: '📷 New photo added to your site',
    lead_received: '🔥 New lead captured from your website', preview_ready: '👀 A new version was published', hosting_active: '🛡 Hosting & security activated',
    build_started: '⚙️ Your website build is underway', invoice_paid: '💳 Payment received — thank you!',
    launched: '🚀 Your website went LIVE', page1_celebrated: '🎉 You hit Page 1 of Google', first_lead_celebrated: '🎉 Your first lead arrived' };
  let evRows = (await db.prepare(`SELECT type, created_at FROM events WHERE client_id = ? AND type IN ('auto_published','revision_done','theme_changed','logo_uploaded','photo_uploaded','lead_received','preview_ready','hosting_active','build_started','invoice_paid','launched','page1_celebrated','first_lead_celebrated') ORDER BY id DESC LIMIT 8`).bind(id).all()).results || [];
  if (previewHeld) evRows = evRows.filter((e) => !HELD_TYPES.includes(e.type));
  // reports list + rank spot-check from GitHub (best effort)
  let reports = [], ranks = null; if (!slug && client && client.live_url && c.env.GITHUB_TOKEN) { try { const _repo = settings.sites_repo || 'conversionco918/conversionco-client-sites'; const _es = client.live_url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('.')[0]; const _rr = await fetch(`https://api.github.com/repos/${_repo}/contents/reports/${_es}/ranks.json?ref=main`, { headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github.raw' } }); if (_rr.ok) { ranks = await _rr.json(); } } catch {} }
  if (slug && c.env.GITHUB_TOKEN) {
    try {
      const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
      const r = await fetch(`https://api.github.com/repos/${repo}/contents/reports/${slug}`, {
        headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' } });
      if (r.ok) {
        const files = await r.json();
        reports = files.filter((f) => f.name.endsWith('.html')).map((f) => f.name).sort().reverse().slice(0, 6);
        const rj = files.find((f) => f.name === 'ranks.json');
        if (rj) {
          const rr = await fetch(rj.download_url, { headers: { 'User-Agent': 'conversionco-mission-control' } });
          if (rr.ok) { try { ranks = await rr.json(); } catch {} }
        }
      }
    } catch {}
  }
  const biz = client.business_name || client.name || 'Your Business';
  const portalStage = previewHeld ? 'generating' : client.stage;
  const stageIdx = PORTAL_STAGES.findIndex(([k]) => k === portalStage);
  const doneIdx = stageIdx === -1 ? (portalStage === 'intake2_sent' ? 2 : 0) : stageIdx;
  const siteUrl = client.live_url || (previewHeld ? '' : client.preview_url) || '';
  const upPct = up && up.total ? Math.round(100 * (up.total - (up.fails || 0)) / up.total) : null;
  const tok = c.req.param('token');
  const isPremium = client.tier === 'premium';
  const bars = score ? Object.entries(score.breakdown).map(([k, v]) =>
    `<div class="bar"><span>${k === 'offsite' ? 'off-site' : k}</span><div class="tr"><div class="fl" style="width:${Math.round(100 * v.score / v.max)}%"></div></div><b>${v.score}/${v.max}</b></div>`).join('') : '';
  const plan = isPremium
    ? ['Custom luxury website — every page designed for you', 'A landing page for every drip (Google loves depth)', 'City pages for local search domination', 'A new SEO article written & published every week', 'Weekly performance report with your SEO Score', 'Daily uptime & security monitoring', 'Review funnel — happy clients routed to Google']
    : ['Custom luxury website — every page designed for you', 'Full search-engine foundation (schema, sitemap, local targeting)', 'Monthly performance report with your SEO Score', 'Daily uptime & security monitoring', 'Booking built into every page'];
  // ---- Portal v2 (7/24): light, professional, report-matched design. Real data only,
  // human voice, no fluff. Section color system mirrors the client reports.
  const escq = (s) => String(s || '').replace(/[<>&]/g, '');
  const ladder = (pos, prev) => {
    const w = pos ? Math.max(6, Math.round(101 - Math.min(100, pos))) : 0;
    const gh = (prev && prev !== pos) ? `<div class="ghost" style="left:${Math.max(2, Math.min(97, Math.round(101 - Math.min(100, prev))))}%"></div>` : '';
    return `<div class="ladder"><div class="goal"></div>${pos ? `<div class="lfill" style="width:0%" data-w="${w}"></div>` : ''}${gh}</div><div class="lscale"><span>#100</span><span>Page 1 🏁</span></div>`;
  };
  const moveTxt = (pos, prev) => (!prev || prev === pos) ? '' : (pos < prev ? ` <span class="up">▲ up from #${prev}</span>` : ` <span class="mut">was #${prev}</span>`);
  let gsc = null; try { gsc = JSON.parse(settings[`gsc_data_${id}`] || 'null'); } catch {}
  const hasGsc = gsc && Array.isArray(gsc.queries) && gsc.queries.length > 0;
  let hist = []; try { hist = JSON.parse(settings[`scorehist_${id}`] || '[]'); } catch {}
  const agrRow = await db.prepare('SELECT * FROM agreements WHERE client_id = ? ORDER BY id DESC LIMIT 1').bind(id).first();
  const agrTok = agrRow ? await portalToken(c.env, 'agr', id) : '';
  // their brand, not ours: accent from their site theme (or a per-client override)
  const accent = settings[`portal_accent_${id}`] || (THEMES[client.theme] && THEMES[client.theme].tokens && THEMES[client.theme].tokens['--gold']) || '#2F7E76';
  const firstName = (client.name || '').split(' ')[0] || '';
  // living welcome line — drawn from their real latest event, fresh every visit
  const WELCOME = { gsc_verified: 'Google is now measuring your website — your exact positions land here soon.',
    launched: 'your website is live on the web and under our care.',
    auto_published: 'a fresh update just went out on your website.',
    revision_done: 'your latest change is done and live.',
    lead_received: 'a new lead just came in through your website.',
    invoice_paid: 'payment received — thank you. Everything below is current.',
    page1_celebrated: 'you are on Page 1 of Google. Enjoy this page.',
    first_lead_celebrated: 'your first lead came in through your website.',
    preview_ready: 'a new version of your website is up.',
    photo_uploaded: 'your new photo is in — thank you.' };
  const welcomeLine = (evRows.length && WELCOME[evRows[0].type])
    ? `${firstName ? firstName + ' — ' : ''}${WELCOME[evRows[0].type]}`
    : `${firstName ? firstName + ', w' : 'W'}elcome back — everything on this page is live and current.`;
  // your story with us — first occurrence of each real milestone
  const MILES = { client_created: 'The day we met', agreement_signed: 'You made it official', build_started: 'We started building',
    preview_ready: 'Your website took its first breath', launched: 'You went live on the web', gsc_verified: 'Google began measuring you',
    page1_celebrated: 'You reached Page 1 of Google', first_lead_celebrated: 'Your first lead arrived' };
  let storyRows = (await db.prepare(`SELECT type, MIN(created_at) AS at FROM events WHERE client_id = ? AND type IN ('client_created','agreement_signed','build_started','preview_ready','launched','gsc_verified','page1_celebrated','first_lead_celebrated') GROUP BY type ORDER BY at`).bind(id).all()).results || [];
  if (previewHeld) storyRows = storyRows.filter((s) => s.type !== 'preview_ready');
  // fresh real win → one-time confetti (client-side localStorage gate)
  const winRow = await db.prepare(`SELECT type, created_at FROM events WHERE client_id = ? AND type IN ('page1_celebrated','first_lead_celebrated') AND created_at > datetime('now','-14 days') ORDER BY id DESC LIMIT 1`).bind(id).first();
  // Page One certificate — earliest genuine Page-1 event, forever
  const certRow = await db.prepare(`SELECT detail, created_at FROM events WHERE client_id = ? AND type = 'page1_celebrated' ORDER BY id ASC LIMIT 1`).bind(id).first();
  const certKw = certRow ? ((String(certRow.detail || '').match(/"([^"]+)"/) || [])[1] || '') : '';
  // 30-day before/after — only when real history spans 25+ days
  const histSpanDays = hist.length >= 2 ? Math.round((Date.parse(hist[hist.length - 1].d) - Date.parse(hist[0].d)) / 86400000) : 0;
  let gscFirst = null; try { gscFirst = JSON.parse(settings[`gsc_first_${id}`] || 'null'); } catch {}
  // first-party visitor counts (our-hosted sites use the slug; externally-hosted
  // sites use the ext-<id> pixel — see /t/:id/t.js).
  // TRUE-DATA GATE (Tiffany 7/24): the tile only exists once the site is genuinely
  // public — a live domain (or pixel on their own live site). Preview peeks by us
  // or the client are NOT "visitors"; pre-launch the tile must not appear at all.
  let visits = null;
  const publiclyLive = !!(client.live_url) || !slug; // no-slug clients only ever get pixel data (their site is live elsewhere)
  if (publiclyLive) {
    const hitSlug = slug || `ext-${id}`;
    const v7 = await db.prepare(`SELECT SUM(n) AS n FROM hits WHERE slug = ? AND day > date('now','-7 days')`).bind(hitSlug).first();
    const v28 = await db.prepare(`SELECT SUM(n) AS n FROM hits WHERE slug = ? AND day > date('now','-28 days')`).bind(hitSlug).first();
    const topP = await db.prepare(`SELECT path, SUM(n) AS n FROM hits WHERE slug = ? AND day > date('now','-28 days') AND path != 'index.html' GROUP BY path ORDER BY n DESC LIMIT 1`).bind(hitSlug).first();
    if (v28 && Number(v28.n) > 0) visits = { w: Number(v7?.n || 0), m: Number(v28.n), top: topP ? String(topP.path).replace('.html', '').replace(/-/g, ' ') : null };
  }
  // lead inbox + client-confirmed bookings (real revenue)
  const leadRows = (await db.prepare(`SELECT id AS lid, name, email, phone, message, source, status, created_at FROM leads WHERE client_id = ? AND slug != 'portal-message' ORDER BY id DESC LIMIT 12`).bind(id).all()).results || [];
  const bookedN = Number((await db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE client_id = ? AND status = 'booked'`).bind(id).first())?.n || 0);
  let avgPrice = 0;
  if (slug) {
    try {
      const meta = JSON.parse((await db.prepare(`SELECT content FROM site_files WHERE slug = ? AND path = 'site-meta.json'`).bind(slug).first())?.content || '{}');
      const prices = (Array.isArray(meta.menu) ? meta.menu : []).map((x) => {
        const raw = typeof x === 'string' ? x : (x && (x.price ?? x[1])) ?? '';
        return Number(String(raw).replace(/[^0-9.]/g, ''));
      }).filter((p) => p > 10 && p < 5000);
      if (prices.length) avgPrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    } catch {}
  }
  // review pulse — engines record it into ranks.json weekly (honest approximations)
  const reviews = (ranks && ranks.reviews && ranks.reviews.you) ? ranks.reviews : null;
  // 📣 ADS / ANALYTICS (8/19/2026) — the client's own marketing numbers, shown
  // to THEM. Our own beacon counts (hits slug ext-<id>, path ev-<name>) render
  // instantly; the live Google Analytics totals are fetched by the page after
  // load from /portal-ads so a slow Google call never blocks the portal.
  // ⭐ RANKINGS (8/19/2026) — Google's own positions, shown to the client. Held
  // back until there are TWO snapshot days, because a one-day card is a flat
  // line with zero movement and reads as "nothing is happening".
  let rankCard = null;
  try {
    const rrows = (await db.prepare(
      `SELECT q, day, pos FROM rank_history WHERE client_id = ? AND day >= date('now','-35 days') ORDER BY day ASC`
    ).bind(id).all()).results || [];
    const rdays = [...new Set(rrows.map((r) => r.day))];
    if (rdays.length >= 2) {
      const latest = rdays[rdays.length - 1];
      const byQ = {};
      for (const r of rrows) (byQ[r.q] = byQ[r.q] || []).push(r);
      const list = Object.entries(byQ).map(([q, h]) => {
        const cur = h[h.length - 1];
        const prior = h.length > 7 ? h[h.length - 8] : h[0];
        return { q, pos: cur.pos, day: cur.day, delta: Math.round((prior.pos - cur.pos) * 10) / 10, spark: h.slice(-14).map((x) => x.pos) };
      }).filter((x) => x.day === latest).sort((a, b) => a.pos - b.pos).slice(0, 8);
      if (list.length) rankCard = list;
    }
  } catch {}
  const sparkSvg = (arr) => {
    if (!arr || arr.length < 2) return '';
    const mn = Math.min(...arr), mx = Math.max(...arr), rng = (mx - mn) || 1;
    const pts = arr.map((v, i) => `${(i / (arr.length - 1) * 56).toFixed(1)},${(2 + ((v - mn) / rng) * 14).toFixed(1)}`).join(' ');
    return `<svg width="58" height="18" viewBox="0 0 58 18" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity=".6"/></svg>`;
  };
  let adsRep = null, adsEv = null;
  try {
    const ar = JSON.parse(settings['ads_' + id] || '{}');
    if (ar && ar.url && ar.portal_analytics !== false) {
      adsRep = ar;
      const evRowsAds = (await db.prepare(
        `SELECT path, SUM(n) AS n FROM hits WHERE slug = ? AND day > date('now','-28 days') GROUP BY path`
      ).bind('ext-' + id).all()).results || [];
      adsEv = { views: 0, call_click: 0, sms_click: 0, form_submit: 0, book_click: 0 };
      for (const r of evRowsAds) {
        const p = String(r.path || '');
        if (p.indexOf('ev-') === 0) { const k = p.slice(3); if (k in adsEv) adsEv[k] += Number(r.n) || 0; }
        else adsEv.views += Number(r.n) || 0;
      }
    }
  } catch {}
  // photo library
  const photoSlots = new Set(((await db.prepare(`SELECT path FROM site_files WHERE slug = ? AND path LIKE 'photo-%'`).bind(`_assets-${id}`).all()).results || []).map((r) => Number(String(r.path).replace('photo-', '')) || 0));
  // share-a-win image data
  const shareData = certRow
    ? { biz, title: 'PAGE ONE OF GOOGLE', sub: certKw ? `"${certKw}"` : '', date: `Verified ${String(certRow.created_at).slice(0, 10)}` }
    : (winRow ? { biz, title: winRow.type === 'first_lead_celebrated' ? 'FIRST LEAD, IN THE BOOKS' : 'A WIN WORTH SHARING', sub: '', date: String(winRow.created_at).slice(0, 10) } : null);
  const tiles = [];
  if (hasGsc) {
    tiles.push(`<div class="tile"><div class="v" data-cnt="${Number(gsc.totals?.imp || 0)}">${Number(gsc.totals?.imp || 0).toLocaleString()}<small>×</small></div><div class="l">Times shown on Google</div></div>`);
    tiles.push(`<div class="tile"><div class="v" data-cnt="${Number(gsc.totals?.clicks || 0)}">${Number(gsc.totals?.clicks || 0).toLocaleString()}</div><div class="l">Clicks to your website</div></div>`);
    const best = Math.min(...gsc.queries.map((q) => q.pos).filter((p) => p > 0));
    if (isFinite(best)) tiles.push(`<div class="tile"><div class="v">#${best}</div><div class="l">Best Google spot</div></div>`);
  }
  if (visits) tiles.push(`<div class="tile"><div class="v" data-cnt="${visits.w > 0 ? visits.w : visits.m}">${(visits.w > 0 ? visits.w : visits.m).toLocaleString()}</div><div class="l">Visitors ${visits.w > 0 ? 'this week' : 'this month'}</div>${visits.top ? `<div class="d">most viewed: ${escq(visits.top)}</div>` : ''}</div>`);
  if (leadsN > 0) tiles.push(`<div class="tile"><div class="v" data-cnt="${leadsN}">${leadsN}</div><div class="l">People who reached out</div></div>`);
  if (bookedN > 0) tiles.push(`<div class="tile"><div class="v" data-cnt="${bookedN}">${bookedN}</div><div class="l">Bookings from your website</div>${avgPrice ? `<div class="d up">~$${(bookedN * avgPrice).toLocaleString()} at your prices</div>` : ''}</div>`);
  if (score) tiles.push(`<div class="tile"><div class="v" data-cnt="${score.total}">${score.total}<small>/100</small></div><div class="l">Website score</div></div>`);
  if (!score && up && up.total >= 3 && upPct !== null) tiles.push(`<div class="tile"><div class="v" data-cnt="${upPct}">${upPct}%</div><div class="l">Uptime, checked daily</div></div>`);
  const FRIENDLY2 = { auto_published: 'Website updated & republished', revision_done: 'A requested change was completed',
    theme_changed: 'Fresh look applied to your site', logo_uploaded: 'Your logo was added', photo_uploaded: 'New photo added to your site',
    lead_received: 'New lead from your website', preview_ready: 'A new version was published', hosting_active: 'Hosting & security activated',
    build_started: 'Your website build is underway', invoice_paid: 'Payment received — thank you', launched: 'Your website went live',
    page1_celebrated: 'You reached Page 1 of Google', first_lead_celebrated: 'Your first lead arrived' };
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${biz} — Client Portal | ConversionCo</title>
<meta name="theme-color" content="${accent}">
<link rel="manifest" href="/portal-manifest/${id}/${tok}">
<link rel="apple-touch-icon" href="/portal-logo/${id}/${tok}">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500&family=Karla:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0}
  :root{--ink:#16202B;--muted:#5B6B7B;--faint:#8A99A8;--paper:#FBFAF7;--card:#FFFFFF;--line:#E7E3DA;--good:#1B7F4B;--navy:#0B1D33;--gold:#A16207;--brand:${accent}}
  body{background:var(--paper);color:var(--ink);font-family:'Karla',-apple-system,sans-serif;font-weight:300;line-height:1.6;font-size:15.5px}
  .wrap{max-width:700px;margin:0 auto;padding:34px 18px 70px}
  .head{display:flex;align-items:center;gap:14px}
  .head img{height:44px;max-width:130px;object-fit:contain;background:#fff;border:1px solid var(--line);border-radius:10px;padding:4px}
  .head .mono{width:46px;height:46px;border-radius:50%;border:1.5px solid var(--brand);display:flex;align-items:center;justify-content:center;font-family:'Cormorant Garamond',serif;font-size:20px;color:var(--brand)}
  h1{font-family:'Cormorant Garamond',Georgia,serif;font-weight:500;font-size:clamp(24px,5.5vw,32px);color:var(--navy);line-height:1.1}
  .sub{color:var(--muted);font-size:12.5px;letter-spacing:.05em;margin-top:3px}
  .card{background:var(--card);border:1px solid var(--line);border-top:3px solid var(--sec,var(--navy));border-radius:18px;padding:22px 20px;margin:14px 0}
  .c-goog{--sec:var(--brand)}.c-cust{--sec:#1B7F4B}.c-score{--sec:#7C3AED}.c-health{--sec:#0E8A8A}.c-rep{--sec:#A16207}.c-blog{--sec:#C2410C}.c-act{--sec:#475569}.c-msg{--sec:#0B1D33}.c-doc{--sec:#0B1D33}.c-story{--sec:var(--brand)}
  .story{position:relative;padding-left:22px;display:grid;gap:14px}
  .story::before{content:"";position:absolute;left:5px;top:6px;bottom:6px;width:2px;background:var(--line);border-radius:2px}
  .story .m{position:relative;font-size:14.5px}
  .story .m::before{content:"";position:absolute;left:-22px;top:5px;width:12px;height:12px;border-radius:50%;background:var(--brand);border:2.5px solid var(--card);box-shadow:0 0 0 1.5px var(--brand)}
  .story .m time{display:block;font-size:11.5px;color:var(--faint)}
  .covers{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:12px}
  .cover{display:block;text-decoration:none;background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:18px 12px 14px;text-align:center;transition:border-color .15s}
  .cover:hover{border-color:var(--brand)}
  .cover .cm{font-family:'Cormorant Garamond',serif;font-size:19px;color:var(--ink);line-height:1.2}
  .cover .cl{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--brand);margin-top:6px;font-weight:500}
  .cover .bar{height:3px;border-radius:2px;background:var(--brand);width:34px;margin:0 auto 12px}
  .cbtns{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .cbtn{background:var(--paper);border:1.5px solid var(--line);border-radius:99px;padding:8px 16px;font-size:13px;color:var(--ink);cursor:pointer;font-family:inherit}
  .cbtn.on{border-color:var(--brand);color:var(--brand);font-weight:500}
  .eyebrow{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--sec,var(--gold));font-weight:500}
  h2{font-family:'Cormorant Garamond',Georgia,serif;font-weight:400;font-size:21px;margin:5px 0 12px;color:var(--ink)}
  .livebar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:18px 0 4px}
  .livepill{display:inline-flex;align-items:center;gap:7px;background:#E7F5EC;color:var(--good);font-weight:500;font-size:13px;padding:7px 14px;border-radius:99px}
  .livepill i{width:8px;height:8px;border-radius:50%;background:var(--good);display:inline-block}
  .btn{display:inline-block;background:var(--brand);color:#fff;font-weight:500;padding:11px 22px;border-radius:10px;text-decoration:none;border:0;font-size:14px;cursor:pointer}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
  .tile{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:16px 12px 13px;text-align:center}
  .tile .v{font-family:'Cormorant Garamond',serif;font-size:36px;line-height:1;color:var(--ink)}
  .tile .v small{font-size:15px;color:var(--muted)}
  .tile .l{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-top:6px}
  .grow{padding:14px 0;border-bottom:1px dashed var(--line)} .grow:last-of-type{border-bottom:0;padding-bottom:4px}
  .grow .kw{font-size:13px;color:var(--muted)} .grow .kw b{color:var(--ink);font-weight:500}
  .ladder{position:relative;height:16px;background:var(--line);border-radius:99px;margin:9px 0 4px}
  .lfill{position:absolute;left:0;top:0;height:100%;border-radius:99px 5px 5px 99px;background:var(--sec,#2F7E76);min-width:8px;transition:width 1.1s cubic-bezier(.22,1,.36,1)}
  @media (prefers-reduced-motion: reduce){.lfill{transition:none}}
  .winbanner{display:none;background:var(--card);border:1.5px solid var(--brand);border-radius:16px;padding:16px 18px;margin:14px 0;text-align:center;font-family:'Cormorant Garamond',serif;font-size:20px;color:var(--ink)}
  .sinceline{display:none;font-size:13px;color:var(--faint);margin-top:5px}
  .framewrap{position:relative;height:300px;overflow:hidden;border-radius:12px;border:1px solid var(--line);background:#fff}
  .framewrap iframe{width:1272px;height:577px;transform:scale(.52);transform-origin:0 0;border:0;pointer-events:none}
  .micbtn{background:var(--paper);border:1.5px solid var(--line);border-radius:99px;width:42px;height:42px;font-size:17px;cursor:pointer;flex:0 0 42px}
  .micbtn.rec{border-color:#B91C1C;background:#FEF2F2;animation:pulse 1.2s infinite}
  @keyframes pulse{50%{transform:scale(1.08)}}
  .ghost{position:absolute;top:-4px;width:2px;height:24px;background:var(--faint);border-radius:2px}
  .goal{position:absolute;right:0;top:0;height:100%;width:10%;border-radius:0 99px 99px 0;background:var(--sec,#2F7E76);opacity:.14}
  .lscale{display:flex;justify-content:space-between;font-size:10.5px;color:var(--faint)}
  .pos{font-size:15px;margin-top:5px} .pos b{font-weight:500;color:var(--sec,#2F7E76);font-family:'Cormorant Garamond',serif;font-size:20px}
  .up{color:var(--good);font-size:12.5px;font-weight:500} .mut{color:var(--faint);font-size:12.5px}
  .note{font-size:12px;color:var(--faint);margin-top:10px}
  .steps{display:flex;flex-direction:column;gap:9px}
  .step{display:flex;gap:11px;align-items:center;font-size:14.5px}
  .dot{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:12px;flex:0 0 24px;background:var(--line);color:var(--muted)}
  .done .dot{background:#E7F5EC;color:var(--good)} .now .dot{background:var(--navy);color:#fff}
  .now{font-weight:500} .pend{color:var(--faint)}
  .checks{display:grid;gap:9px} .check{display:flex;gap:10px;align-items:flex-start;font-size:14.5px}
  .check .tick{color:var(--good);font-weight:600;flex:0 0 auto}
  ul.list{list-style:none;display:grid;gap:8px} ul.list a{color:var(--ink);text-decoration:none;font-size:14.5px;border-bottom:1px solid var(--line);padding-bottom:7px;display:block}
  ul.list a:hover{color:var(--sec,var(--navy))}
  .feed{display:grid;gap:9px;font-size:14px} .feed time{color:var(--faint);font-size:11.5px;display:block}
  textarea{width:100%;background:var(--paper);border:1px solid var(--line);border-radius:10px;color:var(--ink);padding:13px;font-family:inherit;font-size:14.5px;margin-bottom:12px}
  .foot{text-align:center;color:var(--faint);font-size:12px;margin-top:26px} .foot a{color:var(--muted)}
</style></head><body><div class="wrap">
  <div class="head"><img src="/portal-logo/${id}/${tok}" onerror="this.outerHTML='<div class=mono>${escq(biz).slice(0, 1)}</div>'">
    <div><h1>${biz}</h1><div class="sub">Private client portal · prepared by your ConversionCo team${isPremium ? ' · Premium' : ''}</div></div></div>
  <p style="font-family:'Cormorant Garamond',serif;font-style:italic;font-size:17px;color:var(--muted);margin-top:14px">${escq(welcomeLine)}</p>
  <p class="sinceline" id="sinceLine"></p>

  <div class="winbanner" id="winBanner">${winRow ? (winRow.type === 'page1_celebrated' ? '🎉 You are on Page 1 of Google. Take a moment — this is what the work was for.' : '🎉 Your first lead came in through your website. It’s working.') : ''}${shareData ? `<div><button class="cbtn" onclick="shareWin()" style="margin-top:12px">Share this win 📤</button></div>` : ''}</div>

  ${client.stage === 'live'
    ? `<div class="livebar"><span class="livepill"><i></i>Live on the web</span>${siteUrl ? `<a class="btn" href="${siteUrl}" target="_blank">View your website →</a>` : ''}</div>`
    : `<div class="card"><span class="eyebrow">Your Project</span><h2>Where things stand</h2><div class="steps">
    ${PORTAL_STAGES.map(([k, label], i) => `<div class="step ${i < doneIdx ? 'done' : i === doneIdx ? 'now' : 'pend'}"><span class="dot">${i < doneIdx ? '✓' : i === doneIdx ? '●' : i + 1}</span>${label}</div>`).join('')}
  </div>${siteUrl ? `<a class="btn" href="${siteUrl}" target="_blank" style="margin-top:16px">View your website →</a>` : ''}</div>`}

  ${slug ? `<div class="card" style="padding:14px 14px 12px"><div class="framewrap">
    <iframe src="/preview/${slug}/" loading="lazy" title="Your website, live"></iframe>
    <a href="${siteUrl || `/preview/${slug}/`}" target="_blank" style="position:absolute;inset:0" aria-label="Open your website"></a>
  </div><p class="note" style="margin-top:9px;text-align:center">This is what the world sees right now — tap to open it full size.</p></div>` : ''}

  ${tiles.length ? `<div class="card"><span class="eyebrow">At a Glance</span><h2>Your numbers right now</h2><div class="tiles">${tiles.join('')}</div></div>` : ''}

  <div class="card c-goog"><span class="eyebrow">Google</span><h2>Where you stand on Google</h2>
    ${hasGsc ? `<p class="note" style="margin:0 0 6px">Straight from Google's own records — your exact position for searches people typed in the last 28 days · updated ${String(gsc.checked_at).slice(0, 10)}.</p>
      ${gsc.queries.map((q) => `<div class="grow"><div class="kw">when someone searches <b>"${escq(q.q)}"</b></div>${ladder(q.pos, q.prev)}<div class="pos">you're <b>#${q.pos}</b> on Google${moveTxt(q.pos, q.prev)}</div></div>`).join('')}` : ''}
    ${ranks && Array.isArray(ranks.keywords) && ranks.keywords.length ? `
      ${hasGsc ? '<p class="note" style="margin:12px 0 0">And in the searches we run ourselves in your market:</p>' : `<p class="note" style="margin:0 0 6px">We run these exact searches every week${ranks.checked_at ? ` · last checked ${String(ranks.checked_at).slice(0, 10)}` : ''}.</p>`}
      ${ranks.keywords.map((k) => `<div class="grow"><div class="kw">when someone searches <b>"${escq(k.kw)}"</b></div>${ladder(k.you || 0, null)}
        <div class="pos">${k.you ? `you're <b>Page 1, #${k.you}</b>` : (k.pending ? 'your spot is waiting — tracking starts at launch' : `not on Page 1 yet — that's the target`)}</div>
        ${k.competitors ? `<div class="note" style="margin-top:4px">${Object.entries(k.competitors).map(([n, p]) => `${escq(n)}: ${p ? `Page 1, #${p}` : 'not on Page 1'}`).join(' · ')}</div>` : ''}</div>`).join('')}` : ''}
    ${!hasGsc && !(ranks && ranks.keywords && ranks.keywords.length) ? (client.live_url
      ? `<p style="color:var(--muted);font-size:14px">Your website is registered with Google and the measuring has begun — your first exact positions appear here within days, and we re-check them every Sunday.</p><div class="ladder"><div class="goal"></div></div><div class="lscale"><span>#100</span><span>Page 1 🏁</span></div>`
      : `<p style="color:var(--muted);font-size:14px">The day your website goes live, we start tracking exactly where you appear on Google — every week, right here.</p>`) : ''}
  </div>

  ${score ? `<div class="card c-score"><span class="eyebrow">Your Website</span><h2>Website score: ${score.total}/100</h2>
    <div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">
      <svg width="118" height="118" viewBox="0 0 120 120" role="img" aria-label="Score ${score.total} of 100">
        <circle cx="60" cy="60" r="52" fill="none" stroke="var(--line)" stroke-width="9"/>
        <circle cx="60" cy="60" r="52" fill="none" stroke="#7C3AED" stroke-width="9" stroke-linecap="round" stroke-dasharray="${(326.7 * score.total / 100).toFixed(1)} 326.7" transform="rotate(-90 60 60)"/>
        <text x="60" y="57" text-anchor="middle" style="font:400 30px 'Cormorant Garamond';fill:var(--ink)">${score.total}</text>
        <text x="60" y="76" text-anchor="middle" style="font:400 10px 'Karla';fill:var(--muted)">out of 100</text>
      </svg>
      <p style="flex:1;min-width:220px;color:var(--muted);font-size:13.5px">A real audit of your website's search-readiness. The biggest points come from your presence on Google — profile, listings, reviews — so it climbs as that work lands.</p>
    </div>
    ${hist.length >= 2 ? (() => { const w = 560, h = 60, mn = Math.min(...hist.map(p => p.s)) - 3, mx = Math.max(...hist.map(p => p.s)) + 3;
      const pts = hist.map((p, i) => `${(i / (hist.length - 1) * w).toFixed(1)},${(h - (p.s - mn) / Math.max(1, mx - mn) * h).toFixed(1)}`).join(' ');
      return `<svg viewBox="0 0 ${w} ${h + 8}" style="width:100%;height:auto;margin-top:14px"><polyline points="${pts}" fill="none" stroke="#7C3AED" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${w}" cy="${(h - (hist[hist.length - 1].s - mn) / Math.max(1, mx - mn) * h).toFixed(1)}" r="3.5" fill="#7C3AED"/></svg><div class="note">your score since we started — ${hist[0].s} → ${hist[hist.length - 1].s}</div>`; })() : ''}
  </div>` : ''}

  <div class="card c-health"><span class="eyebrow">Health</span><h2>Healthy, safe, and working</h2><div class="checks">
    ${up && up.total ? `<div class="check"><span class="tick">✓</span><span>Looked in on every day — ${up.total} check${up.total === 1 ? '' : 's'} so far${upPct !== null ? `, ${upPct}% clean` : ''}${up.last === 'up' ? ', all clear today' : ''}.</span></div>` : `<div class="check"><span class="tick">✓</span><span>Daily care is switched on — we look in on your website every single day.</span></div>`}
    ${settings[`gsc_${id}`] && (JSON.parse(settings[`gsc_${id}`] || '{}').verified) ? `<div class="check"><span class="tick">✓</span><span>Registered with Google — your site map is in Google's hands, so it knows every page you have.</span></div>` : ''}
    ${billing.sub_status === 'active' ? `<div class="check"><span class="tick">✓</span><span>Hosting &amp; security active — your website is protected around the clock.</span></div>` : ''}
    ${revsN > 0 ? `<div class="check"><span class="tick">✓</span><span>${revsN} change${revsN === 1 ? '' : 's'} completed for you since day one.</span></div>` : ''}
    ${score && score.pages.blogPosts > 0 ? `<div class="check"><span class="tick">✓</span><span>${score.pages.blogPosts} article${score.pages.blogPosts === 1 ? '' : 's'} written and published for you.</span></div>` : ''}
  </div></div>

  ${leadRows.length ? `<div class="card c-cust"><span class="eyebrow">Customers</span><h2>Your inbox</h2>
    <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:4px">
      <div style="font-family:'Cormorant Garamond',serif;font-size:52px;line-height:1" data-cnt="${leadsN}">${leadsN}</div>
      <p style="color:var(--muted);font-size:14px;max-width:400px">people have reached out through your website${bookedN ? ` — <b style="color:var(--good);font-weight:500">${bookedN} booked ✓</b>${avgPrice ? ` <span style="color:var(--faint)">(~$${(bookedN * avgPrice).toLocaleString()} at your average price)</span>` : ''}` : ''}.</p>
    </div>
    ${leadRows.map((L) => `<div class="grow" data-lead="${L.lid}">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline">
        <b style="font-weight:500">${escq(L.name || 'Someone')}</b>
        <span class="note" style="margin:0">${String(L.created_at).slice(0, 10)}${L.source ? ` · via ${escq(L.source)}` : ''}</span>
      </div>
      ${L.message ? `<p style="font-size:13.5px;color:var(--muted);margin-top:3px">"${escq(String(L.message).slice(0, 180))}"</p>` : ''}
      <div style="display:flex;gap:12px;margin-top:8px;flex-wrap:wrap;align-items:center">
        ${L.phone ? `<a href="tel:${escq(L.phone)}" style="font-size:13px;color:var(--brand);text-decoration:none;font-weight:500">📞 Call</a>` : ''}
        ${L.email ? `<a href="mailto:${escq(L.email)}" style="font-size:13px;color:var(--brand);text-decoration:none;font-weight:500">✉️ Email</a>` : ''}
        <span style="margin-left:auto;font-size:12px;color:var(--faint)">Did they book?</span>
        <button class="cbtn bk ${L.status === 'booked' ? 'on' : ''}" onclick="markLead(${L.lid}, 'booked', this)" style="padding:4px 12px;font-size:12px">Booked ✓</button>
        <button class="cbtn bk ${L.status === 'no' ? 'on' : ''}" onclick="markLead(${L.lid}, 'no', this)" style="padding:4px 12px;font-size:12px">No</button>
      </div>
    </div>`).join('')}
  </div>` : ''}

  ${rankCard ? `<div class="card" style="--sec:#7C3AED"><span class="eyebrow">Google Rankings</span><h2>Where you show up on Google</h2>
    <p class="note" style="margin:0 0 12px">Straight from Google Search Console — these are Google's own positions, not an estimate. An arrow means you moved since last week.</p>
    <div style="display:flex;flex-direction:column;gap:2px">
    ${rankCard.map((k) => `<div style="display:flex;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid var(--line)">
      <div style="flex:1;min-width:0;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escq(k.q)}</div>
      <div style="color:var(--faint);flex:none">${sparkSvg(k.spark)}</div>
      <div style="flex:none;width:52px;text-align:right;font-size:12px;color:${k.delta > 0 ? 'var(--good)' : k.delta < 0 ? '#B42318' : 'var(--faint)'}">${k.delta > 0 ? '&#9650; ' + k.delta : k.delta < 0 ? '&#9660; ' + Math.abs(k.delta) : '&mdash;'}</div>
      <div style="flex:none;width:44px;text-align:right;font-family:'Cormorant Garamond',serif;font-size:26px;line-height:1">${k.pos}</div>
    </div>`).join('')}
    </div>
    <p class="note" style="margin-top:12px">Position 1 is the top of page one. Moving from 70 to 40 is real progress even though nobody has clicked yet — it means Google is starting to trust the site.</p>
  </div>` : ''}

  ${adsRep ? `<div class="card" style="--sec:#1A73E8"><span class="eyebrow">Your Marketing</span><h2>What your landing page is doing</h2>
    <p class="note" style="margin:0 0 14px">Last 28 days, measured on your own page — every tap counted the moment it happened.</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px">
      ${[['Page views', adsEv.views], ['Calls tapped', adsEv.call_click], ['Texts tapped', adsEv.sms_click], ['Forms sent', adsEv.form_submit], ['Bookings started', adsEv.book_click]]
        .map(([lbl, n]) => `<div style="background:var(--wash,#FAF9F6);border:1px solid var(--line);border-radius:12px;padding:14px">
          <div style="font-family:'Cormorant Garamond',serif;font-size:34px;line-height:1">${Number(n) || 0}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px">${lbl}</div></div>`).join('')}
    </div>
    <div id="ga4box" style="margin-top:14px;font-size:13.5px;color:var(--muted)">Loading your Google Analytics totals…</div>
    <p class="note" style="margin-top:12px">Calls, texts, forms, and bookings are tracked as key events in your own Google Analytics property${adsRep.ga4_measurement ? ` (${escq(adsRep.ga4_measurement)})` : ''} — so the numbers here and the numbers in Google agree.</p>
  </div>
  <script>
    fetch('/portal-ads/${id}/${tok}').then(r => r.json()).then(d => {
      var b = document.getElementById('ga4box'); if (!b) return;
      if (d && d.ok) b.innerHTML = 'Google Analytics, last 28 days: <b>' + d.sessions.toLocaleString() + '</b> sessions · <b>' + d.users.toLocaleString() + '</b> people · <b>' + d.keyEvents.toLocaleString() + '</b> key events.';
      else b.textContent = 'Google Analytics totals are still warming up — your own counts above are live either way.';
    }).catch(function(){ var b = document.getElementById('ga4box'); if (b) b.textContent = ''; });
  </script>` : ''}

  ${reviews ? `<div class="card" style="--sec:#BE123C"><span class="eyebrow">Reviews</span><h2>Your review pulse</h2>
    <div style="display:flex;gap:20px;align-items:baseline;flex-wrap:wrap">
      <div style="font-family:'Cormorant Garamond',serif;font-size:52px;line-height:1">${Number(reviews.you.count) || 0}</div>
      <div style="color:var(--muted);font-size:14px">Google reviews${reviews.you.rating ? ` · ${escq(String(reviews.you.rating))}★` : ''}${(reviews.you.prev_count != null && Number(reviews.you.count) > Number(reviews.you.prev_count)) ? ` · <b style="color:var(--good);font-weight:500">up ${Number(reviews.you.count) - Number(reviews.you.prev_count)} since last check</b>` : ''}</div>
    </div>
    ${reviews.rivals ? `<p class="note" style="margin-top:10px">The neighbors: ${Object.entries(reviews.rivals).map(([n, r]) => `${escq(n)} ~${Number((r && r.count) != null ? r.count : r) || '?'}`).join(' · ')}</p>` : ''}
  </div>` : ''}

  ${(slug && (photoSlots.size > 0)) ? `<div class="card c-blog"><span class="eyebrow">Your Photos</span><h2>Your photo library</h2>
    <p class="note" style="margin:0 0 12px">The photos we keep on file for your website. Send a new one in the box below — tick "add to my website" and we place it for you.</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:10px">
    ${[1, 2, 3, 4, 5, 6].map((n) => photoSlots.has(n)
      ? `<img src="/portal-photo-view/${id}/${tok}/${n}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;border:1px solid var(--line)" alt="Your photo ${n}" loading="lazy">`
      : `<div style="aspect-ratio:1;border:1.5px dashed var(--line);border-radius:10px;display:flex;align-items:center;justify-content:center;color:var(--faint);font-size:22px">·</div>`).join('')}
    </div></div>` : ''}

  ${reports.length ? `<div class="card c-rep"><span class="eyebrow">Reports</span><h2>Your latest report</h2>
    <p style="color:var(--muted);font-size:13.5px;margin-bottom:12px">The full story — where you stand on Google, what we handled, and what it's worth.</p>
    <a class="btn" href="/portal/${id}/${tok}/report/${reports[0]}" target="_blank">Read your ${reports[0].replace('.html', '')} report →</a>
    ${reports.length > 1 ? `<div class="covers" style="margin-top:16px">
      ${reports.slice(1).map((r) => `<a class="cover" href="/portal/${id}/${tok}/report/${r}" target="_blank"><div class="bar"></div><div class="cm">${r.replace('.html', '')}</div><div class="cl">Report</div></a>`).join('')}
    </div>` : ''}
  </div>` : ''}

  ${storyRows.length >= 2 ? `<div class="card c-story"><span class="eyebrow">Your Story With Us</span><h2>The journey so far</h2>
    <div class="story">
    ${storyRows.map((s) => `<div class="m">${MILES[s.type] || s.type}<time>${String(s.at).slice(0, 10)}</time></div>`).join('')}
    </div></div>` : ''}

  ${(agrRow || certRow) ? `<div class="card c-doc"><span class="eyebrow">Documents</span><h2>Your documents</h2>
    ${agrRow ? `<p style="color:var(--muted);font-size:14px">Your agreement — signed by ${escq(agrRow.signed_name)} on ${String(agrRow.signed_at).slice(0, 10)}, kept right here for your records.</p>
    <a class="btn" style="margin-top:10px" href="/agreement/${id}/${agrTok}" target="_blank">View your signed agreement →</a>` : ''}
    ${certRow ? `<p style="color:var(--muted);font-size:14px;margin-top:${agrRow ? '18px' : '0'}">Your Page One certificate — earned ${String(certRow.created_at).slice(0, 10)}${certKw ? ` for the search "${escq(certKw)}"` : ''}. Print it, frame it — you earned it.</p>
    <a class="btn" style="margin-top:10px;background:#A16207" href="/portal/${id}/${tok}/certificate" target="_blank">Your Page One certificate →</a>
    <button class="cbtn" onclick="shareWin()" style="margin-left:8px">Share it 📤</button>` : ''}
  </div>` : ''}

  ${(histSpanDays >= 25 && score && hist.length >= 2) ? `<div class="card c-score"><span class="eyebrow">Then &amp; Now</span><h2>Your first ${histSpanDays} days</h2>
    <div style="display:flex;gap:26px;align-items:center;flex-wrap:wrap">
      <div style="text-align:center"><div class="note" style="margin:0">then</div><div style="font-family:'Cormorant Garamond',serif;font-size:44px;color:var(--faint);line-height:1">${hist[0].s}</div></div>
      <div style="font-size:24px;color:#7C3AED">→</div>
      <div style="text-align:center"><div class="note" style="margin:0">now</div><div style="font-family:'Cormorant Garamond',serif;font-size:44px;color:#7C3AED;line-height:1">${hist[hist.length - 1].s}</div></div>
      ${(gscFirst && hasGsc && Number(gsc.totals?.imp || 0) > gscFirst.imp) ? `<div style="margin-left:auto;text-align:center"><div class="note" style="margin:0">shown on Google</div><div style="font-size:17px">${Number(gscFirst.imp).toLocaleString()}× → <b style="color:#7C3AED">${Number(gsc.totals.imp).toLocaleString()}×</b></div></div>` : ''}
    </div></div>` : ''}

  ${blogs.length ? `<div class="card c-blog"><span class="eyebrow">Published For You</span><h2>Fresh on your website</h2><ul class="list">${blogs.map((b) => `<li><a href="/preview/${slug}/${b.path}" target="_blank">${b.path.replace('blog-', '').replace('.html', '').replace(/-/g, ' ')} →</a></li>`).join('')}</ul></div>` : ''}

  ${evRows.length ? `<div class="card c-act"><span class="eyebrow">Activity</span><h2>Recently, from your team</h2><div class="feed">
    ${evRows.map((e) => `<div>${FRIENDLY2[e.type] || e.type}<time>${String(e.created_at).slice(0, 10)}</time></div>`).join('')}
  </div></div>` : ''}

  <div class="card c-msg"><span class="eyebrow">Talk To Us</span><h2>How can we help?</h2>
    <div class="cbtns">
      <button class="cbtn on" id="mQ" onclick="setMode('q')">Ask a question</button>
      <button class="cbtn" id="mC" onclick="setMode('c')">Request a change</button>
      <button class="cbtn" id="mP" onclick="setMode('p')">Send us a photo</button>
    </div>
    <form id="msgForm">
      <p id="modeHint" style="color:var(--muted);font-size:13px;margin-bottom:9px">A real person reads every message and replies, usually the same day.</p>
      <div id="photoRow" style="display:none;margin-bottom:11px">
        <input type="file" id="photoFile" accept="image/png,image/jpeg,image/webp" style="font-size:13px;margin-bottom:9px">
        ${slug ? `<label style="display:flex;gap:8px;align-items:center;font-size:13.5px;color:var(--ink)"><input type="checkbox" id="wantOnSite" checked style="width:16px;height:16px;accent-color:var(--brand)"> Please add this photo to my website</label>` : ''}
      </div>
      <div style="display:flex;gap:9px;align-items:flex-start">
        <textarea name="message" id="msgText" rows="3" placeholder="Type your message…" style="flex:1;margin-bottom:0"></textarea>
        <button type="button" class="micbtn" id="micBtn" title="Hold on — talk instead of type" style="display:none">🎤</button>
      </div>
      <button class="btn" type="submit" id="msgBtn" style="margin-top:12px">Send</button>
      <p id="msgOk" style="display:none;color:var(--good);font-weight:500;margin-top:10px"></p>
    </form>
  </div>

  <p class="foot">Website care by <a href="https://conversionco918.com">ConversionCo</a></p>
</div>
<script>
window.CCWIN = ${winRow ? JSON.stringify({ t: winRow.type, at: winRow.created_at }) : 'null'};
window.CCEV = ${JSON.stringify(evRows.map((e) => ({ t: e.type, at: e.created_at })))};
window.CCIMP = ${hasGsc ? Number(gsc.totals?.imp || 0) : 'null'};
window.CCSHARE = ${shareData ? JSON.stringify(shareData) : 'null'};
window.BRAND = '${accent}';
// mark a lead booked / not — powers the real-revenue tracking
async function markLead(lid, status, btn) {
  try {
    await fetch('/portal-lead/${id}/${tok}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lead: lid, status: status }) });
    var row = btn.closest('[data-lead]');
    row.querySelectorAll('.bk').forEach(function (b) { b.classList.remove('on'); });
    btn.classList.add('on');
  } catch (e) {}
}
// share-a-win: draw a branded square, download it
function ccWrap(x, t, cx, y, maxw, lh) {
  var words = String(t).split(' '); var line = ''; var yy = y;
  words.forEach(function (w) { var test = line ? line + ' ' + w : w; if (x.measureText(test).width > maxw && line) { x.fillText(line, cx, yy); yy += lh; line = w; } else line = test; });
  x.fillText(line, cx, yy); return yy;
}
async function shareWin() {
  if (!window.CCSHARE) return;
  try { await document.fonts.load('500 88px "Cormorant Garamond"'); await document.fonts.load('italic 40px "Cormorant Garamond"'); } catch (e) {}
  var cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1080;
  var x = cv.getContext('2d');
  x.fillStyle = '#FBFAF7'; x.fillRect(0, 0, 1080, 1080);
  x.strokeStyle = BRAND; x.lineWidth = 6; x.strokeRect(42, 42, 996, 996);
  x.lineWidth = 1.5; x.strokeRect(60, 60, 960, 960);
  x.textAlign = 'center';
  x.fillStyle = BRAND; x.font = '54px "Cormorant Garamond", serif'; x.fillText('✦', 540, 190);
  x.fillStyle = '#8A99A8'; x.font = '400 26px Karla, sans-serif'; x.fillText('A  W I N  W O R T H  F R A M I N G', 540, 262);
  x.fillStyle = '#16202B'; x.font = '500 84px "Cormorant Garamond", serif';
  var yEnd = ccWrap(x, CCSHARE.biz, 540, 400, 880, 92);
  x.fillStyle = BRAND; x.font = '500 62px "Cormorant Garamond", serif';
  yEnd = ccWrap(x, CCSHARE.title, 540, yEnd + 130, 880, 70);
  if (CCSHARE.sub) { x.fillStyle = '#5B6B7B'; x.font = 'italic 42px "Cormorant Garamond", serif'; ccWrap(x, CCSHARE.sub, 540, yEnd + 90, 860, 50); }
  x.fillStyle = '#8A99A8'; x.font = '400 23px Karla, sans-serif'; x.fillText(CCSHARE.date, 540, 952);
  cv.toBlob(function (b) { var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'my-win.png'; a.click(); });
}
// numbers that move (respecting reduced-motion)
(function () {
  var noMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('.lfill[data-w]').forEach(function (el) {
    var w = el.getAttribute('data-w') + '%';
    if (noMotion) { el.style.width = w; } else { setTimeout(function () { el.style.width = w; }, 150); }
  });
  if (!noMotion) document.querySelectorAll('.tile .v[data-cnt]').forEach(function (el) {
    var target = parseInt(el.getAttribute('data-cnt'), 10); if (!isFinite(target) || target <= 0) return;
    var suffix = el.querySelector('small') ? el.querySelector('small').outerHTML : '';
    var extra = /%$/.test(el.textContent.trim()) ? '%' : '';
    var t0 = null;
    function step(ts) {
      if (!t0) t0 = ts;
      var p = Math.min(1, (ts - t0) / 900); p = 1 - Math.pow(1 - p, 3);
      el.innerHTML = Math.round(target * p).toLocaleString() + extra + suffix;
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
})();
// one-time confetti on a real, recent win
(function () {
  if (!window.CCWIN) return;
  var key = 'cc_win_' + CCWIN.t + '_' + CCWIN.at;
  try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch (e) { return; }
  document.getElementById('winBanner').style.display = 'block';
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var cv = document.createElement('canvas'); cv.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99';
  cv.width = innerWidth; cv.height = innerHeight; document.body.appendChild(cv);
  var ctx = cv.getContext('2d'); var pieces = []; var colors = ['#2F7E76', '#A16207', '#7C3AED', '#1B7F4B', '#BE123C'];
  for (var i = 0; i < 90; i++) pieces.push({ x: Math.random() * cv.width, y: -20 - Math.random() * cv.height * 0.4, r: 3 + Math.random() * 5, c: colors[i % colors.length], v: 2 + Math.random() * 3, a: Math.random() * 6.28, s: (Math.random() - 0.5) * 0.2 });
  var frames = 0;
  (function draw() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    pieces.forEach(function (p) { p.y += p.v; p.a += p.s; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c; ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); ctx.restore(); });
    if (++frames < 260) requestAnimationFrame(draw); else cv.remove();
  })();
})();
// since your last visit — honest diff, stored locally
(function () {
  try {
    var K = 'cc_visit_${id}';
    var last = localStorage.getItem(K);
    if (last) {
      var lv = Date.parse(last); var msgs = [];
      var ups = CCEV.filter(function (e) { return ['auto_published', 'revision_done', 'preview_ready', 'photo_uploaded'].indexOf(e.t) >= 0 && Date.parse(e.at.replace(' ', 'T') + 'Z') > lv; }).length;
      if (ups) msgs.push(ups + ' update' + (ups > 1 ? 's' : '') + ' went out on your website');
      var pi = localStorage.getItem(K + '_imp');
      if (pi !== null && CCIMP !== null && CCIMP > +pi) msgs.push("Google's count of people who saw you grew by " + (CCIMP - +pi));
      if (msgs.length) { var el = document.getElementById('sinceLine'); el.textContent = 'Since you were last here: ' + msgs.join(', and ') + '.'; el.style.display = 'block'; }
    }
    localStorage.setItem(K, new Date().toISOString());
    if (CCIMP !== null) localStorage.setItem(K + '_imp', CCIMP);
  } catch (e) {}
})();
// talk instead of type
(function () {
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var btn = document.getElementById('micBtn');
  if (!SR || !btn) return;
  btn.style.display = 'block';
  var rec = null, on = false;
  btn.addEventListener('click', function () {
    var ta = document.getElementById('msgText');
    if (on) { try { rec.stop(); } catch (e) {} return; }
    rec = new SR(); rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US';
    var base = ta.value ? ta.value + ' ' : '';
    rec.onresult = function (ev) {
      var out = '';
      for (var i = 0; i < ev.results.length; i++) out += ev.results[i][0].transcript;
      ta.value = base + out;
    };
    rec.onend = function () { on = false; btn.classList.remove('rec'); btn.textContent = '🎤'; };
    rec.onerror = function () { on = false; btn.classList.remove('rec'); btn.textContent = '🎤'; };
    rec.start(); on = true; btn.classList.add('rec'); btn.textContent = '⏹';
  });
})();
let MODE = 'q';
const HINTS = {
  q: 'A real person reads every message and replies, usually the same day.',
  c: 'Describe the change in your own words — new price, different photo, updated hours, anything. We take it from there and you get an email when it\\'s live.',
  p: 'Send us any photo — your space, your team, your work.${slug ? " Tick the box and we\\'ll place it on your website for you." : ''}'
};
const PLACEHOLDERS = { q: 'Type your message…', c: 'e.g. "Change the NAD+ price to $850" or "Use a beach photo in the top section"', p: 'Anything we should know about this photo? (optional)' };
function setMode(m) {
  MODE = m;
  for (const [k, elId] of [['q','mQ'],['c','mC'],['p','mP']]) document.getElementById(elId).classList.toggle('on', k === m);
  document.getElementById('modeHint').textContent = HINTS[m];
  document.getElementById('msgText').placeholder = PLACEHOLDERS[m];
  document.getElementById('photoRow').style.display = m === 'p' ? 'block' : 'none';
  document.getElementById('msgText').required = m !== 'p';
}
setMode('q');
document.getElementById('msgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('msgBtn'); btn.disabled = true;
  const msg = document.getElementById('msgText').value;
  const ok = document.getElementById('msgOk');
  try {
    if (MODE === 'p') {
      const f = document.getElementById('photoFile').files[0];
      if (!f) { btn.disabled = false; return alert('Choose a photo first.'); }
      if (f.size > 3200000) { btn.disabled = false; return alert('Please keep photos under ~3MB.'); }
      const b64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
      const want = document.getElementById('wantOnSite');
      const r = await fetch('/portal-photo/${id}/${tok}', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ b64, note: msg, wantOnSite: !!(want && want.checked) }) }).then((x) => x.json());
      if (r.error) { btn.disabled = false; return alert(r.error); }
      ok.textContent = r.queued ? 'Photo received — it will appear on your website within the day. We\\'ll email you when it\\'s live.' : 'Photo received — thank you. It\\'s safely in your library.';
    } else if (MODE === 'c') {
      if (!msg.trim()) { btn.disabled = false; return; }
      await fetch('/portal-req/${id}/${tok}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg }) });
      ok.textContent = 'Change request received — we\\'re on it. You\\'ll get an email when it\\'s live.';
    } else {
      if (!msg.trim()) { btn.disabled = false; return; }
      await fetch('/portal-msg/${id}/${tok}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg }) });
      ok.textContent = 'Sent — we\\'ll get back to you shortly.';
    }
    btn.style.display = 'none'; ok.style.display = 'block';
  } catch { btn.disabled = false; alert('Something hiccuped — try again?'); }
});
</script>
</body></html>`);
});

// Portal message → instant email to Tiffany + logged like a lead
app.post('/portal-msg/:id/:token', async (c) => {
  const id = Number(c.req.param('id'));
  if (c.req.param('token') !== await portalToken(c.env, 'portal', id)) return c.text('nope', 403);
  const db = c.env.DB;
  if (!(await rlOk(db, `pmsg:${id}:${c.req.header('CF-Connecting-IP') || 'noip'}`, 8, 3600)))
    return c.json({ error: "We got your earlier notes — give us a little while and we'll reply to everything at once." }, 429);
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

// Portal logo (tokenized, public): uploaded logo first, then the site's logo file
app.get('/portal-logo/:id/:token', async (c) => {
  const id = Number(c.req.param('id'));
  if (c.req.param('token') !== await portalToken(c.env, 'portal', id)) return c.text('nope', 403);
  const db = c.env.DB;
  let row = await db.prepare(`SELECT content, content_type FROM site_files WHERE slug=? AND path='logo'`).bind(`_assets-${id}`).first();
  if (!row) {
    const slug = await slugForClient(db, id);
    if (slug) row = await db.prepare(`SELECT content, content_type FROM site_files WHERE slug=? AND path='img/logo.png' AND is_base64=1`).bind(slug).first();
  }
  if (!row) return c.text('no logo', 404);
  return c.body(Uint8Array.from(atob(row.content), (ch) => ch.charCodeAt(0)), 200,
    { 'Content-Type': row.content_type || 'image/png', 'Cache-Control': 'public, max-age=3600' });
});

// Per-client PWA manifest: their business as an app on their phone
app.get('/portal-manifest/:id/:token', async (c) => {
  const id = Number(c.req.param('id'));
  const tok = c.req.param('token');
  if (tok !== await portalToken(c.env, 'portal', id)) return c.text('nope', 403);
  const client = await c.env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.text('nope', 404);
  const biz = client.business_name || client.name || 'Client Portal';
  const hasLogo = await c.env.DB.prepare(`SELECT 1 AS x FROM site_files WHERE slug=? AND path='logo'`).bind(`_assets-${id}`).first();
  const icon = hasLogo ? `/portal-logo/${id}/${tok}` : '/icon-192.png';
  return c.json({
    name: biz, short_name: biz.slice(0, 12), start_url: `/portal/${id}/${tok}`,
    display: 'standalone', background_color: '#FBFAF7', theme_color: '#0B1D33',
    icons: [{ src: icon, sizes: '192x192', type: 'image/png' }, { src: hasLogo ? icon : '/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
});

// Portal change request → straight into the revision queue (done within the hour)
app.post('/portal-req/:id/:token', async (c) => {
  const id = Number(c.req.param('id'));
  if (c.req.param('token') !== await portalToken(c.env, 'portal', id)) return c.text('nope', 403);
  const db = c.env.DB;
  if (!(await rlOk(db, `preq:${id}:${c.req.header('CF-Connecting-IP') || 'noip'}`, 8, 3600)))
    return c.json({ error: "We've queued your earlier requests — give us a little while to work through those first." }, 429);
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'not found' }, 404);
  let f = {}; try { f = await c.req.json(); } catch {}
  const msg = String(f.message || '').slice(0, 1500);
  if (!msg.trim()) return c.json({ error: 'empty' }, 400);
  await db.prepare('INSERT INTO revisions (client_id, request) VALUES (?, ?)')
    .bind(id, `[from the client, via their portal] ${msg}`).run();
  await logEvent(db, id, 'portal_message', `✏️ Change request from ${client.name || client.email} (queued): "${msg.slice(0, 100)}"`);
  const settings = await getSettings(db);
  if (settings.notify_email && c.env.GHL_TOKEN && settings.ghl_location_id) {
    try {
      const ghl = ghlFor(c.env, settings);
      const contact = await ghl.upsertContact({ email: settings.notify_email, name: 'ConversionCo Notifications' });
      await ghl.sendEmail({ contactId: contact.id || contact.contactId,
        subject: `✏️ Client change request — ${client.business_name || client.name || client.email} (auto-queued)`,
        html: `<p><b>${client.name || ''}</b> asked via their portal:</p><blockquote style="border-left:3px solid #C9A254;padding-left:12px;">${msg.slice(0, 1200)}</blockquote><p>It's already in the revision queue — applied within the hour unless you pull it in <a href="${BASE_URL}">Mission Control</a>.</p>`,
        emailFrom: settings.email_from || undefined });
    } catch {}
  }
  return c.json({ ok: true, queued: true });
});

// Portal photo upload → client asset library; "add to my website" auto-queues placement
app.post('/portal-photo/:id/:token', async (c) => {
  const id = Number(c.req.param('id'));
  if (c.req.param('token') !== await portalToken(c.env, 'portal', id)) return c.text('nope', 403);
  const db = c.env.DB;
  if (!(await rlOk(db, `pphoto:${id}:${c.req.header('CF-Connecting-IP') || 'noip'}`, 12, 3600)))
    return c.json({ error: 'That is a lot of photos at once — give it an hour and send the rest.' }, 429);
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'not found' }, 404);
  let f = {}; try { f = await c.req.json(); } catch {}
  const b64raw = String(f.b64 || '');
  const m = b64raw.match(/^data:image\/(png|jpeg|jpg|webp);base64,/);
  if (!m) return c.json({ error: 'Please choose a PNG, JPG, or WEBP photo.' }, 400);
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const mime = ext === 'webp' ? 'image/webp' : ext === 'png' ? 'image/png' : 'image/jpeg';
  const clean = b64raw.replace(/^data:[^,]+,/, '');
  if (clean.length > 4_400_000) return c.json({ error: 'Please keep photos under ~3MB.' }, 400);
  // next free library slot (1-6)
  const used = new Set(((await db.prepare(`SELECT path FROM site_files WHERE slug=? AND path LIKE 'photo-%'`).bind(`_assets-${id}`).all()).results || []).map((r) => r.path));
  let slot = 0; for (let i = 1; i <= 6; i++) if (!used.has(`photo-${i}`)) { slot = i; break; }
  if (!slot) return c.json({ error: 'Your photo library is full (6) — reply to any of our emails and we\'ll make room.' }, 400);
  await db.prepare(`INSERT INTO site_files (slug, path, content, content_type, is_base64, updated_at)
    VALUES (?, ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(slug, path) DO UPDATE SET content=excluded.content, content_type=excluded.content_type, updated_at=datetime('now')`)
    .bind(`_assets-${id}`, `photo-${slot}`, clean, mime).run();
  const note = String(f.note || '').slice(0, 500);
  const slug = await slugForClient(db, id);
  let queued = false;
  if (f.wantOnSite && slug && c.env.GITHUB_TOKEN) {
    // push the file into their site's repo folder so the revision runner can use it
    try {
      const settings0 = await getSettings(db);
      const repo = settings0.sites_repo || 'conversionco918/conversionco-client-sites';
      const path = `sites/${slug}/img/client-photo-${slot}.${ext}`;
      const ghHeaders = { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' };
      const getRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, { headers: ghHeaders });
      const existing = getRes.ok ? await getRes.json() : null;
      const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
        method: 'PUT', headers: { ...ghHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `Client photo (portal upload) → ${slug}`, content: clean, ...(existing?.sha ? { sha: existing.sha } : {}) }) });
      if (putRes.ok) {
        await db.prepare(`INSERT INTO site_files (slug, path, content, content_type, is_base64, updated_at)
          VALUES (?, ?, ?, ?, 1, datetime('now'))
          ON CONFLICT(slug, path) DO UPDATE SET content=excluded.content, content_type=excluded.content_type, updated_at=datetime('now')`)
          .bind(slug, `img/client-photo-${slot}.${ext}`, clean, mime).run();
        await db.prepare('INSERT INTO revisions (client_id, request) VALUES (?, ?)')
          .bind(id, `[from the client, via their portal] They uploaded a new photo — img/client-photo-${slot}.${ext} (already committed in sites/${slug}/img/) — and asked for it on their website. Place it tastefully where it fits best${note ? `; their note: "${note}"` : ''}. Keep every other design choice unchanged.`).run();
        queued = true;
      }
    } catch { /* photo is safe in the library either way */ }
  }
  await logEvent(db, id, 'photo_uploaded', `📷 Client uploaded a photo via their portal (library slot ${slot})${queued ? ' — placement auto-queued for the site' : ''}${note ? ` · note: "${note.slice(0, 80)}"` : ''}`);
  const settings = await getSettings(db);
  if (settings.notify_email && c.env.GHL_TOKEN && settings.ghl_location_id) {
    try {
      const ghl = ghlFor(c.env, settings);
      const contact = await ghl.upsertContact({ email: settings.notify_email, name: 'ConversionCo Notifications' });
      await ghl.sendEmail({ contactId: contact.id || contact.contactId,
        subject: `📷 ${client.business_name || client.name || client.email} sent a photo${queued ? ' — placement auto-queued' : ''}`,
        html: `<p><b>${client.name || ''}</b> uploaded a photo via their portal (library slot ${slot}).${note ? `<br>Note: "${note}"` : ''}</p><p>${queued ? 'They asked for it on their website — it\'s already in the revision queue and will be placed within the hour.' : 'It\'s saved in their photo library.'}</p><p><a href="${BASE_URL}">Open Mission Control</a></p>`,
        emailFrom: settings.email_from || undefined });
    } catch {}
  }
  return c.json({ ok: true, slot, queued });
});

// Portal "did they book?" — the client confirms real revenue with one tap
app.post('/portal-lead/:id/:token', async (c) => {
  const id = Number(c.req.param('id'));
  if (c.req.param('token') !== await portalToken(c.env, 'portal', id)) return c.text('nope', 403);
  const db = c.env.DB;
  let f = {}; try { f = await c.req.json(); } catch {}
  const lid = Number(f.lead || 0);
  if (!lid) return c.json({ error: 'no lead' }, 400);
  const raw = String(f.status || '');
  const status = raw === 'booked' ? 'booked' : raw === 'no' ? 'no' : '';
  const res = await db.prepare(`UPDATE leads SET status = ? WHERE id = ? AND client_id = ? AND slug != 'portal-message'`).bind(status, lid, id).run();
  if (!res.meta || res.meta.changes === 0) return c.json({ error: 'not found' }, 404);
  if (status === 'booked') {
    await logEvent(db, id, 'lead_booked', `💰 Client marked a lead as BOOKED (lead #${lid})`);
  }
  return c.json({ ok: true, status });
});

// Portal photo library viewer — serves the client's own uploaded photos
app.get('/portal-photo-view/:id/:token/:n', async (c) => {
  const id = Number(c.req.param('id'));
  if (c.req.param('token') !== await portalToken(c.env, 'portal', id)) return c.text('nope', 403);
  const n = Math.min(6, Math.max(1, Number(c.req.param('n')) || 1));
  const row = await c.env.DB.prepare('SELECT content, content_type FROM site_files WHERE slug = ? AND path = ?')
    .bind(`_assets-${id}`, `photo-${n}`).first();
  if (!row) return c.text('no photo', 404);
  return c.body(Uint8Array.from(atob(row.content), (ch) => ch.charCodeAt(0)), 200,
    { 'Content-Type': row.content_type || 'image/jpeg', 'Cache-Control': 'private, max-age=600' });
});

// 📜 Page One certificate — print-ready, earned only (real page1_celebrated event)
app.get('/portal/:id/:token/certificate', async (c) => {
  const id = Number(c.req.param('id'));
  if (c.req.param('token') !== await portalToken(c.env, 'portal', id)) return c.text('nope', 403);
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  const ev = await db.prepare(`SELECT detail, created_at FROM events WHERE client_id = ? AND type = 'page1_celebrated' ORDER BY id ASC LIMIT 1`).bind(id).first();
  if (!client || !ev) return c.text('Not found', 404);
  const settings = await getSettings(db);
  const accent = settings[`portal_accent_${id}`] || (THEMES[client.theme] && THEMES[client.theme].tokens && THEMES[client.theme].tokens['--gold']) || '#2F7E76';
  const biz = client.business_name || client.name || 'This business';
  const kw = (String(ev.detail || '').match(/"([^"]+)"/) || [])[1] || '';
  const when = new Date(String(ev.created_at).replace(' ', 'T') + 'Z').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Page One of Google — ${biz}</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;1,400&family=Karla:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0}
body{background:#EFEBE2;font-family:'Karla',sans-serif;color:#16202B;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
.cert{background:#FDFCF8;max-width:760px;width:100%;padding:64px 56px;text-align:center;border:1px solid #E7E3DA;box-shadow:0 20px 60px rgba(22,32,43,.12);position:relative}
.cert::before{content:"";position:absolute;inset:14px;border:1.5px solid ${accent};pointer-events:none}
.cert::after{content:"";position:absolute;inset:19px;border:.5px solid ${accent}55;pointer-events:none}
.crest{width:58px;height:58px;border-radius:50%;border:1.5px solid ${accent};display:flex;align-items:center;justify-content:center;font-family:'Cormorant Garamond',serif;font-size:24px;color:${accent};margin:0 auto 22px}
.eyebrow{font-size:11px;letter-spacing:.34em;text-transform:uppercase;color:#8A99A8;margin-bottom:20px}
h1{font-family:'Cormorant Garamond',serif;font-weight:500;font-size:40px;line-height:1.1;margin-bottom:6px}
.rule{width:60px;height:2px;background:${accent};margin:22px auto}
.body{font-size:15.5px;color:#5B6B7B;max-width:480px;margin:0 auto;line-height:1.75}
.body b{color:#16202B;font-weight:500}
.big{font-family:'Cormorant Garamond',serif;font-style:italic;font-size:26px;color:${accent};margin:20px 0}
.date{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#8A99A8;margin-top:30px}
.sig{font-family:'Cormorant Garamond',serif;font-style:italic;font-size:18px;margin-top:26px}
.sig small{display:block;font-family:'Karla',sans-serif;font-style:normal;font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:#8A99A8;margin-top:6px}
.printbtn{position:fixed;top:18px;right:18px;background:#0B1D33;color:#fff;border:0;border-radius:99px;padding:11px 22px;font-size:13px;cursor:pointer}
@media print{.printbtn{display:none}body{background:#fff;padding:0}.cert{box-shadow:none;border:0}}
</style></head><body>
<button class="printbtn" onclick="window.print()">Print / save</button>
<div class="cert">
  <div class="crest">${(biz).slice(0, 1)}</div>
  <div class="eyebrow">Certificate of Achievement</div>
  <h1>${biz}</h1>
  <div class="rule"></div>
  <p class="body">has earned a place on <b>Page One of Google</b> — not through advertising, but through a website and search presence strong enough that Google itself put it there${kw ? ' for the search' : ''}.</p>
  ${kw ? `<div class="big">"${kw}"</div>` : ''}
  <div class="date">Verified · ${when}</div>
  <p class="sig">The ConversionCo Team<small>conversionco918.com</small></p>
</div>
</body></html>`);
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
  <p class="sub" style="margin-top:10px">+ $99/month Website Care Plan — hosting, a complete backup of your website, and your own client portal, plus security and daily uptime monitoring. Starts only when your site is live.</p></div>
  <div class="cta"><h2 style="color:inherit">Ready when you are, ${(client.name || 'friend').split(' ')[0]}.</h2>
  <p style="opacity:.75">Grab a time and we'll walk through it together.</p>
  ${settings.booking_link ? `<a class="btn" href="${settings.booking_link}">Book your call</a>` : ''}</div>
  <div class="foot">Crafted by ConversionCo · conversionco918.com</div>
</body></html>`);
});

// GBP concierge: a beautiful tokenized walkthrough so saying yes to the Google
// Business Profile is effortless (the biggest unlock in the score).
app.get('/gbp/:id/:token', async (c) => {
  const id = Number(c.req.param('id'));
  if (c.req.param('token') !== await portalToken(c.env, 'gbp', id)) return c.text('not found', 404);
  const client = await c.env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.text('not found', 404);
  const biz = client.business_name || client.name || 'Your Business';
  let city = '';
  try { const i1 = JSON.parse(client.intake1_data || '{}'); city = i1['Primary City & State'] || ''; } catch {}
  const steps = [
    ['Go to Google', `On your phone, open <b>google.com/business</b> and sign in with the Google account you use for ${biz}.`],
    ['Add your business', `Tap <b>Add your business</b> and type it exactly like this: <b>${biz}</b>${city ? ` — ${city}` : ''}. Consistent spelling matters to Google.`],
    ['Pick your category', `Choose <b>“IV therapy service”</b> (or the closest match). You can add more categories later — we'll tell you which.`],
    ['Location & hours', `If clients come to you, enter your address. If you travel to them, choose “I deliver goods and services” and set your service area${city ? ` around ${city}` : ''}. Add your real hours.`],
    ['Phone & website', `Use the same phone number that's on your website, and your website address — matching details are a ranking signal.`],
    ['Verify', `Google will offer a verification method (video, phone, or postcard). Do it right away — nothing counts until you're verified.`],
  ];
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Google setup — ${biz}</title>
<style>body{font-family:-apple-system,'Segoe UI',sans-serif;background:#FBFAF7;color:#16202B;margin:0;padding:0 0 60px;line-height:1.65}
.wrap{max-width:640px;margin:0 auto;padding:0 20px}.hero{background:#0B1D33;color:#fff;padding:44px 0 36px}
.hero .wrap p{opacity:.8}.hero h1{font-size:clamp(24px,6vw,32px);margin:8px 0 6px}
.eyebrow{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#C9A254;font-weight:600}
.step{background:#fff;border:1px solid #E7E3DA;border-radius:14px;padding:20px 22px;margin-top:14px;display:flex;gap:16px}
.n{width:34px;height:34px;border-radius:50%;background:#0B1D33;color:#C9A254;display:flex;align-items:center;justify-content:center;font-weight:600;flex:0 0 34px}
.step h3{margin:2px 0 6px;font-size:16px}.step p{margin:0;font-size:14.5px;color:#5B6B7B}
.done{background:#fff;border:1px solid #C9A254;border-radius:14px;padding:22px;margin-top:26px;text-align:center}
.done b{font-size:16px}.done p{color:#5B6B7B;font-size:14px;margin:8px 0 0}
.foot{text-align:center;color:#8A99A8;font-size:12px;margin-top:30px}</style></head><body>
<div class="hero"><div class="wrap"><span class="eyebrow">15 minutes · we're with you</span>
<h1>Put ${biz} on Google Maps</h1>
<p>This is the single biggest step for showing up when locals search. Six steps — do them in order, and reply to any of our emails if you get stuck on one.</p></div></div>
<div class="wrap">
${steps.map((s, i) => `<div class="step"><div class="n">${i + 1}</div><div><h3>${s[0]}</h3><p>${s[1]}</p></div></div>`).join('')}
<div class="done"><b>Done? Tell us. 🎉</b><p>Reply to any ConversionCo email with the word <b>“verified”</b> — we take it from there: photos, services, your review link, and wiring it to your website. Your score jumps the moment it's live.</p></div>
<div class="foot">Prepared for ${biz} by ConversionCo · conversionco918.com</div>
</div></body></html>`);
});

// Lead capture from client sites (public, CORS)
app.options('/lead/:slug', (c) => { corsHeaders(c); return c.body(null, 204); });
app.post('/lead/:slug', async (c) => {
  corsHeaders(c);
  const slug = c.req.param('slug');
  const db = c.env.DB;
  let f = {}; try { f = await c.req.json(); } catch { try { f = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)])); } catch {} }
  // 🧪 QA marker: proves the form → worker → client mapping WITHOUT creating a
  // lead or sending any email. Builders/tests submit name "__qa-test".
  if (String(f.name || '') === '__qa-test' || f._qa) {
    const metaQ = await db.prepare(`SELECT content FROM site_files WHERE slug=? AND path='site-meta.json'`).bind(slug).first();
    let cidQ = null; try { cidQ = JSON.parse(metaQ?.content || '{}').client_id ?? null; } catch {}
    return c.json({ ok: true, qa: true, slugKnown: !!metaQ, mapped: cidQ != null, client_id: cidQ });
  }
  // 🛡 spam shields — both answer "ok" so bots learn nothing:
  // 1. honeypot: forms carry a hidden "website" field humans never see; bots fill it
  if (String(f.website || f._hp || '').trim()) return c.json({ ok: true });
  // 2. rate limit: max 5 submissions per hour per visitor per site
  const ipL = c.req.header('CF-Connecting-IP') || 'noip';
  if (!(await rlOk(db, `lead:${slug}:${ipL}`, 5, 3600))) return c.json({ ok: true });
  const meta = await db.prepare(`SELECT content FROM site_files WHERE slug=? AND path='site-meta.json'`).bind(slug).first();
  let clientId = null; try { clientId = JSON.parse(meta?.content || '{}').client_id ?? null; } catch {}
  // lead-source tag: explicit field (utm/?s= from the form) beats referrer sniffing
  let source = String(f.src || f.source || '').slice(0, 60).trim();
  if (!source) {
    const ref = String(c.req.header('Referer') || '');
    if (/[?&](utm_source|s)=/i.test(ref)) source = decodeURIComponent((ref.match(/[?&](?:utm_source|s)=([^&]+)/i) || [])[1] || '').slice(0, 60);
    else if (ref) source = 'website';
  }
  if (!source) source = 'direct';
  // 🎯 Attribution rides along from the page (window.ccAttribution()). Without
  // gclid stored here the lead can never be reported back to Google, and every
  // downstream number — cost per lead, cost per booking, ROI — is a guess.
  let at = {};
  try { at = (typeof f.attr === 'object' && f.attr) ? f.attr : JSON.parse(f.attr || '{}'); } catch {}
  const A = (k, n) => String(at[k] == null ? '' : at[k]).slice(0, n);
  if (!source && (A('gclid', 200) || A('wbraid', 200) || A('gbraid', 200))) source = 'google-ads';
  await db.prepare(`INSERT INTO leads (client_id, slug, name, email, phone, message, source, kind,
      gclid, wbraid, gbraid, utm_source, utm_medium, utm_campaign, utm_term, utm_content, landing_page, device, referrer)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'form', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(clientId, slug, String(f.name || '').slice(0, 120), String(f.email || '').slice(0, 160),
      String(f.phone || '').slice(0, 40), String(f.message || '').slice(0, 1500), source,
      A('gclid', 200), A('wbraid', 200), A('gbraid', 200),
      A('utm_source', 60), A('utm_medium', 60), A('utm_campaign', 80), A('utm_term', 80), A('utm_content', 80),
      A('landing_page', 120), A('device', 20), A('referrer', 160)).run();
  await logEvent(db, clientId, 'lead_received', `🔥 New lead on ${slug} (via ${source}): ${f.name || 'no name'} ${f.phone || f.email || ''}`);
  // 📧 KIT (ConvertKit) — if a Kit form id is configured, subscribe the email
  // address to it as well, so the site's join box feeds her list without the
  // page ever having to talk to Kit directly.
  //
  // NOTE (2026-08-20): this used to POST the PUBLIC browser endpoint
  // app.kit.com/forms/<id>/subscriptions. That endpoint sits behind Kit's bot
  // guard: a server-to-server call from a Cloudflare IP comes back HTTP 200
  // with {"status":"quarantined"} and the address never reaches the list. The
  // 200 made it look like it worked. We now use the AUTHENTICATED v4 API,
  // which is the supported server-side path and is not guarded.
  //
  // Two calls, because v4 splits them: create the subscriber, then attach them
  // to the form so her per-form reporting and form-triggered automations fire.
  // Best effort throughout: a Kit outage must never cost her the lead, which is
  // already saved above.
  const kitEmail = String(f.email || '').trim();
  if (kitEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(kitEmail)) {
    const settingsK = await getSettings(db);
    const kitId = String(settingsK['kit_form_' + slug] || settingsK.kit_form_id || '').replace(/\D/g, '');
    const kitKey = c.env.KIT_API_KEY;
    // NO ALARM when there is no API key. The page already subscribed this
    // address from the visitor's browser (window.ccListSubscribe), which is the
    // supported path — the server-side call is an optional backstop for leads
    // that arrive from somewhere other than the website. Logging an error here
    // marked every ordinary lead as a failure.
    if (kitId && kitKey) {
      c.executionCtx.waitUntil((async () => {
        const hdrs = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Kit-Api-Key': kitKey };
        try {
          const r1 = await fetch('https://api.kit.com/v4/subscribers', {
            method: 'POST', headers: hdrs,
            body: JSON.stringify({ email_address: kitEmail, first_name: String(f.name || '').slice(0, 60) || undefined }),
          });
          // 200 = already existed, 201 = created, 202 = queued. All fine.
          if (!r1.ok) {
            const b1 = await r1.text().catch(() => '');
            await logEvent(db, clientId, 'error', `Kit create-subscriber returned HTTP ${r1.status} for ${kitEmail}: ${b1.slice(0, 140)} (the lead itself was saved)`);
            return;
          }
          const r2 = await fetch('https://api.kit.com/v4/forms/' + kitId + '/subscribers', {
            method: 'POST', headers: hdrs,
            body: JSON.stringify({ email_address: kitEmail, referrer: `${BASE_URL}/preview/${slug}/` }),
          });
          if (!r2.ok) {
            const b2 = await r2.text().catch(() => '');
            await logEvent(db, clientId, 'error', `Kit add-to-form ${kitId} returned HTTP ${r2.status} for ${kitEmail}: ${b2.slice(0, 140)} (subscriber was created, the lead was saved)`);
            return;
          }
          await logEvent(db, clientId, 'kit_subscribed', `\u{1F4E7} ${kitEmail} added to the Kit list from ${slug} (form ${kitId})`);
        } catch (e) {
          await logEvent(db, clientId, 'error', `Kit subscribe failed for ${kitEmail}: ${String(e && e.message || e).slice(0, 100)} (the lead itself was saved)`);
        }
      })());
    }
  }
  // 📨 FORWARD EVERY LEAD TO THE CLIENT INSTANTLY — the lead is the product; it
  // should reach the nurse's inbox in seconds, not sit in the portal unseen.
  if (clientId) {
    const clientFwd = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
    if (clientFwd && clientFwd.email) {
      const settingsFwd = await getSettings(db);
      const escF = (s) => String(s || '').replace(/[<>&]/g, '');
      const firstFwd = (clientFwd.name || '').split(' ')[0] || 'there';
      const purlFwd = `${BASE_URL}/portal/${clientId}/${await portalToken(c.env, 'portal', clientId)}`;
      const nmF = escF(f.name) || 'Someone';
      const phF = escF(f.phone); const emF = escF(f.email); const msgF = escF(String(f.message || '').slice(0, 800));
      c.executionCtx.waitUntil(emailClient(c.env, db, clientFwd, settingsFwd,
        `🔥 New inquiry from your website — ${nmF}`,
        `<p>${firstFwd} — someone just reached out through your website:</p>
<p style="font-size:17px"><b>${nmF}</b>${phF ? ` · <a href="tel:${phF}">${phF}</a>` : ''}${emF ? ` · <a href="mailto:${emF}">${emF}</a>` : ''}</p>
${msgF ? `<blockquote style="border-left:3px solid #C9A254;padding-left:12px;color:#444">${msgF}</blockquote>` : ''}
<p>Reaching out while it's warm makes all the difference — most people book with whoever answers first.</p>
<p>When they book, tap <b>Booked ✓</b> next to their name in your portal so your reports count the real revenue:</p>
<p><a href="${purlFwd}">${purlFwd}</a></p>
<p>— The ConversionCo Team</p>`,
        'lead_forwarded', `📨 Lead forwarded to ${clientFwd.email} in real time (${nmF})`));
    }
  }
  // 🎉 FIRST-LEAD CELEBRATION: the moment their website earns its first potential customer
  if (clientId) {
    const n = (await db.prepare('SELECT COUNT(*) AS n FROM leads WHERE client_id = ?').bind(clientId).first())?.n || 0;
    if (n === 1) {
      const clientRow = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(clientId).first();
      const settingsC = await getSettings(db);
      const firstC = (clientRow?.name || '').split(' ')[0] || 'there';
      const purl = `${BASE_URL}/portal/${clientId}/${await portalToken(c.env, 'portal', clientId)}`;
      c.executionCtx.waitUntil(emailClient(c.env, db, clientRow, settingsC,
        `It happened — your first lead 🎉`,
        `<p>${firstC} — it happened.</p>
<p>Your website just brought you its <b>first potential customer</b>. A real person found you, liked what they saw, and reached out — all on their own.</p>
<p>Their details are in your portal (and in the email we just sent you):</p><p><a href="${purl}">${purl}</a></p>
<p>The first one is the hardest. From here, it compounds.</p><p>— The ConversionCo Team</p>`,
        'first_lead_celebrated', '🎉 First-lead celebration email sent'));
    }
  }
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

// 🔎 Visitor counting for sites we DON'T host: one line pasted into their site —
// <script defer src="<BASE>/t/<clientId>/t.js"></script> — sends a 1px beacon per
// page view into the same hits table (slug ext-<id>), bot-filtered like /preview.
app.get('/t/:id/t.js', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  // ═══ ONE-PASTE TRACKING v2 (8/19/2026) ═══════════════════════════════════
  // One script tag on the client's page does everything:
  //   • visitor beacon (our own counts, bot-filtered)
  //   • Google Analytics 4 (their own property)
  //   • Google Tag Manager container (optional — only if she sets a GTM id)
  //   • Google Ads tag (optional — only if she sets an AW- conversion id)
  //   • Microsoft Clarity session replay
  //   • the four key events, auto-bound: call_click · sms_click · form_submit ·
  //     book_click — pushed to BOTH gtag and dataLayer so GTM can consume them
  //   • GOHIGHLEVEL SUPPORT: GHL renders forms and calendars inside iframes, so
  //     a normal submit listener never sees them. We listen for the postMessage
  //     those iframes send to the parent page and fire the event from there.
  //   • ?qa=1 marks the visit internal so her own testing never counts as a lead
  // ?mode=events — bind the key events ONLY, load nothing. Use this when the
  // page already carries Google's own gtag and Microsoft's own Clarity tag, so
  // nothing is loaded twice. fire() below already calls window.gtag / window.clarity
  // if they exist, so the four key events still land in both tools.
  const eventsOnly = String(c.req.query('mode') || '') === 'events';
  let ga4 = '', clar = '', gtm = '', aw = '';
  try {
    const s = await getSettings(c.env.DB);
    const rep = JSON.parse(s['ads_' + id] || '{}');
    ga4 = String(rep.ga4_measurement || (rep.checks && rep.checks.ga4 && rep.checks.ga4.id) || '').replace(/[^A-Z0-9-]/gi, '');
    clar = String(rep.clarity_id || (rep.checks && rep.checks.clarity && rep.checks.clarity.id) || '').replace(/[^A-Za-z0-9]/g, '');
    gtm = String(rep.gtm_id || '').replace(/[^A-Z0-9-]/gi, '');
    aw = String(rep.aw_id || '').replace(/[^A-Z0-9-]/gi, '');
  } catch {}

  let js = "(function(){try{";
  js += "if(window.__ccTrack)return;window.__ccTrack=1;";
  js += "var qa=/[?&]qa=1/.test(location.search);";
  js += "window.dataLayer=window.dataLayer||[];";
  // ── FIRST-TOUCH CLICK ATTRIBUTION ──────────────────────────────────────
  // Google stamps every ad click with gclid (or wbraid/gbraid on iOS). If the
  // page does not keep it, the lead can never be tied back to the click that
  // was paid for, and Smart Bidding stays blind. FIRST touch wins: someone who
  // arrives on an ad, leaves, and returns direct a week later was still bought
  // by that ad. Kept 90 days, matching Google's own conversion window.
  js += "var A=null;try{";
  js += "var Q=new URLSearchParams(location.search);var now=Date.now();";
  js += "var K='cc_attr';var cur=null;try{cur=JSON.parse(localStorage.getItem(K)||'null');}catch(e){}";
  js += "if(cur&&cur.t&&(now-cur.t)>7776000000)cur=null;";                       // 90 days
  js += "var click=Q.get('gclid')||Q.get('wbraid')||Q.get('gbraid')||'';";
  js += "var hasUtm=Q.get('utm_source')||Q.get('utm_campaign')||'';";
  js += "if(click||hasUtm||!cur){";
  js += "var fresh={t:now,gclid:Q.get('gclid')||'',wbraid:Q.get('wbraid')||'',gbraid:Q.get('gbraid')||'',";
  js += "utm_source:Q.get('utm_source')||'',utm_medium:Q.get('utm_medium')||'',utm_campaign:Q.get('utm_campaign')||'',";
  js += "utm_term:Q.get('utm_term')||'',utm_content:Q.get('utm_content')||'',";
  js += "landing_page:(location.pathname||'/').slice(0,120),";
  js += "device:(/Mobi|Android|iPhone/i.test(navigator.userAgent)?'mobile':/iPad|Tablet/i.test(navigator.userAgent)?'tablet':'desktop'),";
  js += "referrer:(document.referrer||'').slice(0,160)};";
  // only overwrite an existing first touch when THIS visit is itself a paid/tagged click
  js += "if(!cur||click||hasUtm){if(!cur||click||hasUtm){cur=fresh;}}";
  js += "try{localStorage.setItem(K,JSON.stringify(cur));}catch(e){}";
  js += "}A=cur;}catch(e){}";
  js += "window.ccAttribution=function(){return A||{};};";
  // our own beacon — always on, even with no Google ids yet
  js += "var p=encodeURIComponent(location.pathname||'/');(new Image()).src='" + BASE_URL + "/t/" + id + "/p.gif?p='+p+'&r='+Date.now();";

  if (eventsOnly) { ga4 = ''; clar = ''; gtm = ''; aw = ''; }

  if (gtm) {
    js += "(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});";
    js += "var f=d.getElementsByTagName(s)[0],j=d.createElement(s);j.async=true;";
    js += "j.src='https://www.googletagmanager.com/gtm.js?id='+i;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','" + gtm + "');";
  }
  if (ga4 || aw) {
    const first = ga4 || aw;
    js += "var s=document.createElement('script');s.async=1;s.src='https://www.googletagmanager.com/gtag/js?id=" + first + "';document.head.appendChild(s);";
    js += "function gtag(){dataLayer.push(arguments);}window.gtag=window.gtag||gtag;";
    js += "gtag('js',new Date());";
    if (ga4) js += "gtag('config','" + ga4 + "',qa?{traffic_type:'internal'}:{});";
    if (aw) js += "gtag('config','" + aw + "');";
  }
  if (clar) {
    js += "(function(w,d,t,u){w.clarity=w.clarity||function(){(w.clarity.q=w.clarity.q||[]).push(arguments)};var e=d.createElement(t);e.async=1;e.src=u;d.head.appendChild(e);})(window,document,'script','https://www.clarity.ms/tag/" + clar + "');";
  }

  // ── the shared fire() — every path below goes through this one function ──
  js += "var seen={};";
  js += "var fire=function(n,extra){try{";
  js += "var k=n+'|'+Math.floor(Date.now()/1500);if(seen[k])return;seen[k]=1;";           // 1.5s dedupe
  js += "var d=extra||{};if(qa)d.traffic_type='internal';";
  js += "if(window.gtag)window.gtag('event',n,d);";                                        // GA4 (+Ads via config)
  js += "window.dataLayer.push(Object.assign({event:n},d));";                              // GTM-consumable
  js += "if(window.clarity)window.clarity('set','cc_event',n);";                           // Clarity segment
  js += "var aq='';try{if(A){aq='&g='+encodeURIComponent(A.gclid||A.wbraid||A.gbraid||'')+'&us='+encodeURIComponent(A.utm_source||'')+'&uc='+encodeURIComponent(A.utm_campaign||'')+'&lp='+encodeURIComponent(A.landing_page||'')+'&dv='+encodeURIComponent(A.device||'');}}catch(e){}";
  js += "(new Image()).src='" + BASE_URL + "/t/" + id + "/p.gif?p=ev-'+encodeURIComponent(n)+aq+'&r='+Date.now();"; // our own count + attribution
  js += "}catch(e){}};";
  js += "window.ccTrackEvent=fire;";                                                       // manual hook if ever needed

  // ── plain-DOM bindings (works on any normal page, incl. non-iframe GHL parts) ──
  js += "document.addEventListener('click',function(e){var t=e.target;if(!t||!t.closest)return;";
  js += "var a=t.closest('a[href]');";
  js += "if(a){var href=a.getAttribute('href')||'';";
  js += "if(href.indexOf('tel:')===0){fire('call_click');return;}";
  js += "if(href.indexOf('sms:')===0){fire('sms_click');return;}";
  js += "if(/janeapp\\.com|calendly\\.com|calendar\\.google\\.com\\/calendar\\/appointments|\\/widget\\/booking|book|schedul/i.test(href)){fire('book_click');return;}}";
  js += "var b=t.closest('[data-cc-event]');if(b){fire(b.getAttribute('data-cc-event'));return;}";  // manual tagging escape hatch
  js += "var btn=t.closest('button,.cta,[role=button]');";
  js += "if(btn){var txt=(btn.textContent||'').toLowerCase();";
  js += "if(/call|phone/.test(txt)&&!/recall/.test(txt))fire('cta_click',{cta:'call'});";
  js += "else if(/text|message/.test(txt))fire('cta_click',{cta:'text'});";
  js += "else if(/book|schedul|appointment|reserve/.test(txt))fire('cta_click',{cta:'book'});}";
  js += "},true);";
  js += "document.addEventListener('submit',function(e){fire('form_submit');},true);";

  // ── GOHIGHLEVEL iframe bridge: forms + calendars post to the parent window ──
  js += "window.addEventListener('message',function(ev){try{";
  js += "if(!/(msgsndr|leadconnectorhq|gohighlevel|funnels\\.msgsndr)\\.com$/.test((new URL(ev.origin)).hostname.replace(/^.*?([^.]+\\.[^.]+)$/,'$1')))return;";
  js += "var d=ev.data;var str=typeof d==='string'?d:JSON.stringify(d||{});str=str.toLowerCase();";
  js += "if(/appointment|booking|slot_?booked|calendar.*(book|confirm)/.test(str)){fire('book_click',{source:'ghl'});return;}";
  js += "if(/form.*(submit|complete|success)|submit.*success|survey.*complete/.test(str)){fire('form_submit',{source:'ghl'});return;}";
  js += "}catch(e){}},false);";

  js += "}catch(e){}})();";
  return c.body(js, 200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' });
});

// Save the tracking IDs for a client (GA4 / GTM / Clarity / Google Ads) — the
// snippet reads these live, so changing one here updates every page in ~5 min
// with no re-paste on the client's site.
app.post('/api/clients/:id/ads-ids', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'no such client' }, 404);
  let body = {}; try { body = await c.req.json(); } catch {}
  const settings = await getSettings(db);
  let rep = {}; try { rep = JSON.parse(settings['ads_' + id] || '{}'); } catch {}
  const clean = (v, rx) => String(v || '').trim().replace(rx, '');
  if ('ga4' in body) rep.ga4_measurement = clean(body.ga4, /[^A-Z0-9-]/gi).toUpperCase();
  if ('gtm' in body) rep.gtm_id = clean(body.gtm, /[^A-Z0-9-]/gi).toUpperCase();
  if ('clarity' in body) rep.clarity_id = clean(body.clarity, /[^A-Za-z0-9]/g);
  if ('aw' in body) rep.aw_id = clean(body.aw, /[^A-Z0-9-]/gi).toUpperCase();
  for (const k of ['ga4_measurement', 'gtm_id', 'clarity_id', 'aw_id']) if (!rep[k]) delete rep[k];
  await setSetting(db, 'ads_' + id, JSON.stringify(rep));
  await logEvent(db, id, 'ads_ids', `🏷 Tracking IDs updated — ${['ga4_measurement', 'gtm_id', 'clarity_id', 'aw_id'].filter((k) => rep[k]).map((k) => k.replace('_measurement', '').replace('_id', '')).join(', ') || 'all cleared'}`);
  return c.json({ ok: true, ga4: rep.ga4_measurement || '', gtm: rep.gtm_id || '', clarity: rep.clarity_id || '', aw: rep.aw_id || '' });
});

app.get('/t/:id/p.gif', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (ch) => ch.charCodeAt(0));
  const gifHeaders = { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, private' };
  const ua = c.req.header('User-Agent') || '';
  if (!id || !ua || /bot|crawl|spider|slurp|headless|preview|monitor|lighthouse|pingdom/i.test(ua)) return c.body(GIF, 200, gifHeaders);
  let p = String(c.req.query('p') || '/');
  try { p = decodeURIComponent(p); } catch {}
  p = p.replace(/^\/+/, '').replace(/\/$/, '').slice(0, 80) || 'index.html';
  const day = new Date().toISOString().slice(0, 10);
  c.executionCtx.waitUntil(c.env.DB.prepare(`INSERT INTO hits (slug, day, path, n) VALUES (?, ?, ?, 1)
    ON CONFLICT(slug, day, path) DO UPDATE SET n = n + 1`).bind(`ext-${id}`, day, p).run());

  // 📞 CALL TRACKING — for a mobile IV service most high-intent people tap the
  // phone number instead of filling a form. Those leads used to be invisible:
  // no row anywhere, so cost-per-lead was overstated and Google never learned
  // that the click worked. A tel: tap now becomes a real lead row of kind
  // 'call', carrying the same click attribution as a form lead, so it flows
  // into the ROI view and the offline conversion upload like anything else.
  // Rate-limited per IP so one person mashing the button is one lead.
  if (p === 'ev-call_click') {
    const ipC = c.req.header('CF-Connecting-IP') || 'noip';
    c.executionCtx.waitUntil((async () => {
      try {
        if (!(await rlOk(c.env.DB, `callclick:${id}:${ipC}`, 1, 1800))) return;   // one per 30 min
        const g = String(c.req.query('g') || '').slice(0, 200);
        await c.env.DB.prepare(
          `INSERT INTO leads (client_id, slug, name, email, phone, message, source, kind, gclid, utm_source, utm_campaign, landing_page, device)
           VALUES (?, ?, '', '', '', ?, ?, 'call', ?, ?, ?, ?, ?)`
        ).bind(id, '', 'Tapped the phone number on the site', g ? 'google-ads' : 'website',
          g, String(c.req.query('us') || '').slice(0, 60), String(c.req.query('uc') || '').slice(0, 80),
          String(c.req.query('lp') || '').slice(0, 120), String(c.req.query('dv') || '').slice(0, 20)).run();
        await logEvent(c.env.DB, id, 'call_click', `\u{1F4DE} Someone tapped the phone number${g ? ' (from a Google Ads click)' : ''}`);
      } catch {}
    })());
  }
  return c.body(GIF, 200, gifHeaders);
});

// Quiz beacon: which-drip quiz taps → market-demand counters (no PII, bot-filtered).
// Sites call GET /qz/<slug>/<state> (state = short token like wrecked/sick/depleted/longgame).
app.get('/qz/:slug/:state', async (c) => {
  const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (ch) => ch.charCodeAt(0));
  const gifHeaders = { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, private', 'Access-Control-Allow-Origin': '*' };
  const ua = c.req.header('User-Agent') || '';
  const slug = String(c.req.param('slug') || '').replace(/[^a-z0-9-]/gi, '').slice(0, 60);
  const state = String(c.req.param('state') || '').replace(/[^a-z0-9-]/gi, '').slice(0, 30);
  if (!slug || !state || !ua || /bot|crawl|spider|slurp|headless|preview|monitor|lighthouse|pingdom/i.test(ua)) return c.body(GIF, 200, gifHeaders);
  // admin sessions never count (same true-data gate as visits)
  if (await checkSession(c.env, c.req.header('Cookie'))) return c.body(GIF, 200, gifHeaders);
  c.executionCtx.waitUntil((async () => {
    const db = c.env.DB;
    let counts = {}; try { counts = JSON.parse((await db.prepare('SELECT value FROM settings WHERE key = ?').bind(`qz_${slug}`).first())?.value || '{}'); } catch {}
    counts[state] = (counts[state] || 0) + 1;
    await setSetting(db, `qz_${slug}`, JSON.stringify(counts));
  })());
  return c.body(GIF, 200, gifHeaders);
});

// Keyed: lead-form mapping proof for headless builders (GET — they can't POST).
// Same truth as the __qa-test marker: does this slug accept leads for a client?
// 🔎 GOOGLE POWERS (8/19/2026, keyed + read-only): which Google scopes are
// actually live on GOOGLE_REFRESH_TOKEN right now. Every call is a GET — this
// route can never create a property, an event, or a calendar entry. Answers
// "did the re-consent take?" without guessing and without side effects.
app.get('/api/google-scopes/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const env = c.env;
  const out = { at: new Date().toISOString(), configured: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN) };
  if (!out.configured) return c.json(out);
  let token = '';
  try {
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' }),
    });
    const td = await tr.json();
    token = td.access_token || '';
    out.token = !!token;
    if (!token) out.token_error = String(td.error_description || td.error || '').slice(0, 90);
  } catch (e) { out.token = false; out.token_error = String(e && e.message || e).slice(0, 90); }
  if (!token) return c.json(out);
  const H = { Authorization: 'Bearer ' + token };
  const probe = async (name, url) => {
    try { const r = await fetch(url, { headers: H }); out[name] = r.ok ? 'ok' : 'http-' + r.status; }
    catch (e) { out[name] = 'error'; }
  };
  await probe('search_console', 'https://www.googleapis.com/webmasters/v3/sites');
  await probe('calendar', 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1');
  await probe('analytics_admin', 'https://analyticsadmin.googleapis.com/v1beta/accounts');
  await probe('analytics_summaries', 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries');
  // scope alone is not enough: GA4 auto-create needs an Analytics ACCOUNT shell
  // to hang the property on. Count it, so a green scope never hides an empty one.
  if (out.analytics_admin === 'ok') {
    try {
      const a = await fetch('https://analyticsadmin.googleapis.com/v1beta/accounts', { headers: H }).then((r) => r.json());
      out.ga_accounts = ((a && a.accounts) || []).length;
      out.ga4_ready = out.ga_accounts > 0;
    } catch { out.ga_accounts = null; }
  }
  out.reads = { search_console: 'Search Console rankings', calendar: 'Meet/Calendar after-call autopilot',
    analytics_admin: 'GA4 property auto-create', analytics_summaries: 'GA4 numbers in the portal' };
  return c.json(out);
});

app.get('/api/lead-qa/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const slug = String(c.req.query('slug') || '');
  if (!slug) return c.json({ ok: false, error: 'slug required' });
  const meta = await c.env.DB.prepare(`SELECT content FROM site_files WHERE slug=? AND path='site-meta.json'`).bind(slug).first();
  let cid = null; try { cid = JSON.parse(meta?.content || '{}').client_id ?? null; } catch {}
  return c.json({ ok: true, slugKnown: !!meta, mapped: cid != null, client_id: cid,
    note: meta ? (cid != null ? 'form submissions will reach this client' : 'site imported but site-meta has no client_id — leads would be ORPHANED') : 'slug not imported yet — publishes on the next auto-publish cycle' });
});

// Keyed: Cloudflare token health — identity + zone visibility (read-only)
app.get('/api/cf-check/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  if (!c.env.CLOUDFLARE_API_TOKEN) return c.json({ ok: false, error: 'no token set' });
  const cfGet = async (p) => {
    const res = await fetch(`https://api.cloudflare.com/client/v4${p}`, {
      headers: { Authorization: `Bearer ${c.env.CLOUDFLARE_API_TOKEN}` } });
    return res.json().catch(() => ({}));
  };
  try {
    const verify = await cfGet('/user/tokens/verify');
    const accounts = await cfGet('/accounts');
    const zones = await cfGet('/zones?per_page=50');
    return c.json({
      ok: true,
      tokenId: verify && verify.result ? verify.result.id : null,
      tokenStatus: verify && verify.result ? verify.result.status : (verify.errors ? JSON.stringify(verify.errors).slice(0, 150) : 'unknown'),
      accounts: accounts && accounts.success ? (accounts.result || []).map((a) => ({ name: a.name, id: a.id })) : 'cannot list',
      zones: zones && zones.success ? (zones.result || []).map((z) => ({ name: z.name, status: z.status, account: z.account && z.account.name })) : 'cannot list: ' + JSON.stringify(zones.errors || []).slice(0, 150),
    });
  } catch (e) { return c.json({ ok: false, error: String(e.message).slice(0, 150) }); }
});

// 🎯 Keyed: the PROSPECTOR drops hunted businesses here (GET — headless sessions
// can only WebFetch). Dedupes hard, stores honest evidence + an outreach draft
// Tiffany approves and sends HERSELF. The demo builder picks the prospect up on
// its normal cycle. Nothing here ever emails the business directly.
app.get('/api/add-prospect/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const db = c.env.DB;
  const q = c.req.query();
  const biz = String(q.biz || '').trim().slice(0, 120);
  const cty = String(q.city || '').trim().slice(0, 80);
  const vertical = String(q.vertical || 'iv-therapy').trim().slice(0, 40);
  const email = String(q.email || '').trim().slice(0, 160); // ONLY a publicly published address — never guessed
  const site = String(q.site || '').trim().slice(0, 200);
  const evidence = String(q.evidence || '').trim().slice(0, 500);
  const draft = String(q.draft || '').trim().slice(0, 1800);
  if (!biz || !cty) return c.json({ ok: false, error: 'biz + city required' }, 400);
  // hard dedupe: same business name (loose match) anywhere in the pipeline
  const dupe = await db.prepare(`SELECT id, stage FROM clients WHERE LOWER(REPLACE(business_name,' ','')) = ?`)
    .bind(biz.toLowerCase().replace(/ /g, '')).first();
  if (dupe) return c.json({ ok: false, skipped: true, reason: `already in pipeline (id ${dupe.id}, ${dupe.stage})` });
  const placeholderEmail = email || `prospect+${biz.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}@conversionco918.com`;
  const existing = await db.prepare('SELECT id FROM clients WHERE email = ?').bind(placeholderEmail).first();
  if (existing) return c.json({ ok: false, skipped: true, reason: 'email already in pipeline' });
  const intake1 = JSON.stringify({
    'Business Name': biz, 'Contact Name': '', 'Email': placeholderEmail,
    'Primary City & State': cty,
    'Services Offered': vertical === 'med-spa' ? 'Med spa treatments' : vertical === 'injector' ? 'Botox & filler' : vertical === 'lash-brow' ? 'Lashes & brows' : vertical === 'weight-loss' ? 'Medical weight loss' : 'IV therapy',
    '_prospect': true, '_hunted': true, '_vertical': vertical,
    '_their_site': site, '_evidence': evidence, '_created': new Date().toISOString(),
  });
  const r = await db.prepare(`INSERT INTO clients (email, name, business_name, stage, vertical, intake1_data) VALUES (?, '', ?, 'prospect', ?, ?)`)
    .bind(placeholderEmail, biz, vertical, intake1).run();
  const id = r.meta.last_row_id;
  if (draft) await setSetting(db, `outreach_${id}`, draft);
  await logEvent(db, id, 'prospect_created', `🎯 Hunted prospect: ${biz} (${cty}, ${vertical})${evidence ? ` — ${evidence.slice(0, 90)}` : ''} — demo queued${draft ? ' + outreach drafted' : ''}`);
  return c.json({ ok: true, id });
});

// Keyed: read/update an outreach draft (also readable by the dashboard)
app.get('/api/outreach/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const id = Number(c.req.query('id'));
  if (!id) return c.json({ ok: false, error: 'id required' });
  const settings = await getSettings(c.env.DB);
  const set = c.req.query('draft');
  if (set !== undefined) { await setSetting(c.env.DB, `outreach_${id}`, String(set).slice(0, 1800)); return c.json({ ok: true }); }
  return c.json({ ok: true, draft: settings[`outreach_${id}`] || '' });
});

// Keyed: run the nightly backup on demand (verification / before risky changes)
app.get('/api/backup-now/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const out = await backupDatabase(c.env);
  return c.json(out);
});

// Keyed: one-line owner alert — lets the engines (and reminders) email Tiffany
app.get('/api/notify-owner/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const subject = String(c.req.query('subject') || '').slice(0, 150);
  const msg = String(c.req.query('msg') || '').slice(0, 2000);
  if (!subject) return c.json({ ok: false, error: 'subject required' });
  const settings = await getSettings(c.env.DB);
  const ok = await notifyOwner(c.env, settings, subject, `<p>${msg.replace(/[<>&]/g, '')}</p>`);
  return c.json({ ok });
});

// Public portfolio feed (for the ConversionCo showcase page)
app.get('/portfolio.json', async (c) => {
  const db = c.env.DB;
  const clients = (await db.prepare(`SELECT * FROM clients WHERE stage IN ('preview_ready','live')`).all()).results || [];
  const settings = await getSettings(db);
  const out = [];
  for (const cl of clients) {
    // approval gate: held previews stay out of the public portfolio too
    let bP = {}; try { bP = JSON.parse(cl.billing || '{}'); } catch {}
    if (cl.stage === 'preview_ready' && bP.preview_hold && !bP.preview_approved) continue;
    const score = await computeScore(db, cl, settings).catch(() => null);
    let up = null; try { up = JSON.parse(settings[`uptime_${cl.id}`] || 'null'); } catch {}
    out.push({ business: cl.business_name || cl.name, url: cl.live_url || cl.preview_url,
      tier: cl.tier || 'standard', score: score?.total ?? null, pages: score?.pages?.total ?? null,
      uptimePct: up && up.total ? Math.round(100 * (up.total - (up.fails || 0)) / up.total) : null });
  }
  c.header('Access-Control-Allow-Origin', '*');
  return c.json({ sites: out });
});

// ---- PWA: installable Mission Control (public routes — manifest fetches lack cookies) ----
const ICON192 = 'iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAADiUlEQVR42u3dy03kQBRA0cZCIohZEQP7yYsIyItEJhUWSAgJGMqu/3vnrmfcbuq4XO6f7x7+PN2kqx3+BAJIAAkgASQBJIAEkACSABJAAkgASQAJIAEkgCSABJAAEkACSAJIAAkgASQBJIAEkACSABJAAkgASQAJIAEkgASQdLV7f4LPvb48lvyzv8///K3eu/ND44VoYAKopRuSkgJq7ia5pESABtBJyCgFoMF0UjGKD+isnl+HvPkGAUp9TZ78yj8soJJxbTiogx8OoJl6ug7kxIcGKM745WF00DP+4mviVaEZ6Mqo1NB5fXms/O+x56GDnl83WzNh/OfRY8xDwT/OscJRHvt1oAiAfjqUG77A0+kd+wCT0EHP3Hlod0MHPYVbrh/pkIYCroFWXnPEWw9tDOjbA7fJCP00JTSZKr7dw30noYOeReahTQ35Vsa5gYz0InJeQFtPP8EmoSAzUCs9JUPYapi9lbHiKSb2CRSg7acfk5BFtBID6jfDn93yOnsCUOqzwO777xR2/aD3mtBmgL4OWNc3LoYZ+vosNqJpBhJAU1esyU9kZiDlANTjQG+1zZX3DaCwF8AxnkveU1jbQzztSsgaSABZtQC0u560hg56GAJIAIWYfhJOQmYgASSAgp1Z8pzFDiA8lxSAst3KZJfnaw0kgASQAJqwLIixju70ZQGABJAL4Oj7vxmgmrl9nVsdxLiAdwoTQJufBfzQuLNY6vPXLcPNVuwzQEWH6SL3Li3cfoDfCc27iO43Ttne8d0YUOXP5PYY6fJthpl+bvG+2jzLUE49MU9h4w1V6nEKW241M9JQvZ6tV05hf2RzjKHkem5h7trcZHhOnV+abDnAVdt97IvMUzft/viXbe8BHfsbGu4bn3GvALpyrA8esKV2xiK6wbpknS8WRnrBOtQMtML45aETGVDhfNNwOAc/HECrGKof10U+BQDQZEblI918gwBFMzRsXQ8QRnnppAM0jFGqj5WlA9RPUsKPI6YG1EpSTjcAuSYHSAvkq80CSAAJIAEkASSABJAAkgASQAJIAEkACSABpDhN/nmXVLdY79Tcj0eagQSQABJAyphvZcgMJIAEkACSABJAAkgASQAJIAEkgCSABJAAEkASQAJIAAkgASQBJIAEkACSABJAAkgASQAJIAEkgCSABJAAEkACSAJIAAkgASQBJIAEkACSABJAWrQ32LZxEm35/n4AAAAASUVORK5CYII=';
const ICON512 = 'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAJ70lEQVR42u3dy20bSxCGUdEQwCC4UgzcMy9GoLyUCFPx3oYfmmdV/efsL8DuoevrHgm6l+vt/gZAnh+2AEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAI72bguY7evzY81//ni+7CFTXa63u13ArFcFBABMfD1AAMDE1wMEAMx9JUAAwNxXAgQAzH0lQADA3FcCBACMfhlAAMDcVwIEAIx+GUAAMPqRAQQAox8ZQAAw+pEBDubPQWP62z3cAMDwchVAAGDS6F88PccsBASA+dP/gBE5foEIAPSYjKcPxMxVIwBwzhwsO/5sAgKA6Z8+8mwIAoDRnz7m7A8CgOkfPdpsFAKA6Z8+zmwaAoApFj3FbCACgOEVPbnsJAJA+swKH1i2FAEgcVSZU/YWASBuQhlPNpkK/DloDKYqtt0Zf40VNwAKzRGj354jAMRNosp/vWf8XxbSAP7EKyCip/9b4VclW+2bd0EIAKZ/PxrArrwCYq95UXz0/7LGXp9WjHEDwKxxFXAPQAAw/dcts/5w1AAEgNLT//F8Ofvv2oD126sBCAC7TP/WK+0yGTUAAcD0j74KaAACwJB5VCR1jcai4iIAnH/8N4maNsAlAAEw/YOm//8sttdY1AAEANPfPUADEACazJ3KtWs3E5UYAeC4o5+JM6kBLgECgOk/efp/d70dZ6IGIACY/u4BGoAAUGm+tAte04Go0AgADnr4biAAbPQvPOr4H3sJ0AABgCHT3/MCAWDV4a7vNFl/nu17Il781FwCBAAAAcDxP/X47xKAAGD6505/DUAASOQHiZ4jAkDo8d+SbaN/PgKAYyOeJgKAQ1zwkm0mAoADI54pAsDE41vrSbH3ibX1iXjZk3UJEAAABADH/9Tjv0sAAgCAADCL479LAAJAe+7s+EYhADj+G4guAQiAwxr4XiEAOP67BPjaIwAAAkDqPd3x3yUgYb0IAAACQOR1xyUABMBAXP4egDG8BRIAcPx3CUAAcADEdwABwInYYm2+xQoAGEDGIgKAuz++CQgAjp9W6ikgAAAIAG792QfPpkdjb4EEAAABAIfrsEsAAoDJCL51AsBcHV/49ho3HYejHwMIAAACAA7UYZ8ZAQBAAHDStECPxi1HABjDz/rw3UAAcMb0+REAAAQAHJ+tAgEAQADAwdlaEABMFvANFAD66fJ7fvPGSpcV+U1QAQCz0roQADAlrQ4BAEAAwAHZGhEAMBmtFAEAM9F6EQAABAAch60aAQBz0NoRAAAEAMd/OwACAIAA4PBrH0AAABAAAASA3rz3sBsIAAACgAOvPQEBwJTBNwQB4G/8H1zxDUQAABAAavOSwc4gAAAIAAACwGzectgfBIDQEeOXRirvj/wIAEaGEWN/5FwAABAAAAQAAAGgJy/i8a1AAIbwszh86xAAAAQAAAHgd1744vuAAAAIAJ35iRy+bwgAbv34JiAAAAiAW7kP6SF6iAgA7v74DiAAAALADAvu5g6Ajv97f8cQAAAEANcU7AwCQIUh4i1QJu9/EAAAAcBhEE8cAaC1+vd0bxI8NQQAR0I8awQAx0nPyydEAHAwxFNGAAAQAA65sx95PPRW4fh9WPZ8PSkBAEAAcAlwCXD8RwAYyc8JPVMEAAdMn9DTQQBwYDRl2q7a8R8BcMwE3xwEAJcAx38EwBYYNxpg+kuyAGDoaIDpb/oLAAACgLOnS4DjPwJALg0Imf4IAE6gGhA6/R3/BQAN8DntOQIAJ10Cxsyjg1fh5Q8CwF4jSQOmTn/H/0CX6+1uFxzn6w+LdgfbXltk+rsB4B5Qdxz3mlCmPwKAC0RiA1yP6MIrIHN81ew4ZSiXnXcdd8Px3w2AXCv//Z8yi2vOLNMfNwDcA+KuAk2Xb/rjBkDjQfx4vs6dYid+AO/9cQOg0EA5/UR52EwcsFLHfwSAgWNl1wzMWKDpjwCw1/SsM18sx/RHADBlvrG01h/e9EcAMGs8EU8EAeC8iWPoeBBU5tdA2Xde+G1F0x8BQAMw/anFKyCOG98mkT1HAMidR0aSraYOr4A4eo54I2T64wZA9HgyoewtAkD0nDKqbCkCQPTAypxZdhIBwOSKG142EAHAFIubYjYNAcA4yxpqNgoBQAPippv9QQCQgaxJZ0MQADQga/DZBAQADThOzv+I2PRHAJCBkyfj+AUiANB1RG44NMcsBASA6Ay0ZvQjAMiA0Q+b8eegMb/sHm4A4Cpg9CMAIANGPwIAMmD0IwAgA0Y/AgBKYO4jACADRj8CAEpg7iMAoATmPgIAoSUw9xEAyCqBuY8AQEoPTHwEAFJ6YOIjADC/CmY9AgDANP4cNIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgDAv7zbgm19fX7YBNjJ4/myCW4AAAgAAAIAgAAAIAAACAAAAgAgAABEulxvd7sA4AYAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAAAIAgAAAIAAACAAAAgCAAAAgAAAIAAACAIAAACAAAAgAgADYAgABAEAAABAAAAQAAAEAQAAAEAAABAAAAQBAAAAQAAAEAAABAEAAABAAAAQAAAEAYIWfEyHLXsxkRCoAAAAASUVORK5CYII=';
function b64bytes(b64) { const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
app.get('/manifest.json', (c) => c.json({
  name: 'ConversionCo Mission Control', short_name: 'MissionCtrl',
  start_url: '/', display: 'standalone', background_color: '#071B33', theme_color: '#071B33',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
  ],
}));
app.get('/icon-192.png', (c) => c.body(b64bytes(ICON192), 200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' }));
app.get('/icon-512.png', (c) => c.body(b64bytes(ICON512), 200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' }));

// Everything below requires a session — EXCEPT client-facing tokened links:
// /exit/:id/:token (the offboarding download) carries its own HMAC token check
// inside the route, so departing clients need no login to get their files.
app.use('*', async (c, next) => {
  if (c.req.path.startsWith('/exit/')) return next();
  // /portal-ads/:id/:token — the client's own analytics feed; the route checks
  // its own HMAC token, exactly like every other /portal-* lane above.
  if (c.req.path.startsWith('/portal-ads/')) return next();
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
  const newLeads = (await db.prepare(`SELECT l.*, c.business_name AS cbiz, c.name AS cname FROM leads l LEFT JOIN clients c ON c.id = l.client_id WHERE l.created_at > datetime('now','-2 days') AND (l.status IS NULL OR l.status = '') ORDER BY l.id DESC LIMIT 20`).all()).results || [];

  let collected = 0, outstanding = 0, hostingCount = 0, mrrTotal = 0;
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
    if (b.sub_status === 'active') { hostingCount++; mrrTotal += (PRICES[b.sub_plan] && ['hosting','care199','care399'].includes(b.sub_plan) ? PRICES[b.sub_plan].amount : PRICES.hosting.amount) / 100; }

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
    if (cl.stage === 'preview_ready' && b.preview_hold && !b.preview_approved) {
      if (dot === 'green') dot = 'yellow'; why.push('preview held — awaiting your review');
      needs.push({ id: cl.id, sev: 2, kind: 'preview', msg: `⏸ ${label} — website is BUILT and waiting on you: review the preview, then hit Send` });
    }
    health[cl.id] = { dot, why: why.join(' · ') || 'all good' };
  }
  for (const l of newLeads) needs.push({ id: l.client_id, sev: 3, kind: 'lead', msg: `🔥 New lead for ${l.cbiz || l.cname || 'client'}: ${l.name || l.email || l.phone || 'someone'} (${ago2(l.created_at)})` });
  // undelivered client emails — silence here is how clients quietly get lost
  const emailBad = (await db.prepare(`SELECT client_id, to_email, subject, status FROM email_log WHERE status IN ('failed','dead') AND created_at > datetime('now','-7 days') ORDER BY id DESC LIMIT 10`).all()).results || [];
  for (const eb of emailBad) needs.push({ id: eb.client_id, sev: eb.status === 'dead' ? 1 : 2, kind: 'email',
    msg: `📧 ${eb.status === 'dead' ? 'GAVE UP after 4 tries' : 'Delivery failed (auto-retrying)'} — "${String(eb.subject).slice(0, 60)}" to ${eb.to_email}` });
  needs.sort((a, b2) => a.sev - b2.sev);
  const buildProgress = {};
  for (const cl of clients) {
    if (cl.stage !== 'generating') continue;
    let prog = {}; try { prog = JSON.parse(settings[`buildprog_${cl.id}`] || '{}'); } catch {}
    buildProgress[cl.id] = { pct: prog.pct || 5, step: prog.step || 'Build started', started_at: prog.started_at || cl.updated_at,
      updated_at: prog.updated_at || prog.started_at || cl.updated_at };
  }
  return { money: { collected, outstanding, hostingCount, mrr: Math.round(mrrTotal) }, needs: needs.slice(0, 12), health, buildProgress };
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
  // EDIT VISIBILITY: unpublished-edit badges, keyed by slug (editpending_<slug> is
  // maintained by the edit-watcher cron and cleared by importSite on completion)
  const edits = [];
  for (const k of Object.keys(settings)) {
    if (!k.startsWith('editpending_') || !settings[k]) continue;
    try { const p = JSON.parse(settings[k]); if (p && p.n) edits.push({ slug: k.slice(12), ...p }); } catch {}
  }
  return c.json({ clients, events, settings, overview, edits, webhook_path: `/webhooks/ghl/${webhookSecret}` });
});

// 📜 SITE ACTIVITY (session-protected): the "what actually happened" page —
// every edit, publish, import and rollback across all clients, newest first.
app.get('/activity', async (c) => {
  const db = c.env.DB;
  const rows = (await db.prepare(
    `SELECT e.*, c.business_name AS biz, c.name AS cname FROM events e LEFT JOIN clients c ON c.id = e.client_id
     WHERE e.type IN ('site_edit','published','auto_published','import_progress','preview_ready','site_rolled_back','revision_done','revision_failed','build_started','demo_ready')
     ORDER BY e.id DESC LIMIT 300`).all()).results || [];
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ICON = { site_edit: '📝', published: '✅', auto_published: '🚀', import_progress: '📦', preview_ready: '★', site_rolled_back: '⏪', revision_done: '✅', revision_failed: '⚠️', build_started: '⚙️', demo_ready: '💡' };
  const LABEL = { site_edit: 'Edited', published: 'Published', auto_published: 'Auto-published', import_progress: 'Importing', preview_ready: 'Preview ready', site_rolled_back: 'Rolled back', revision_done: 'Revision done', revision_failed: 'Revision failed', build_started: 'Build started', demo_ready: 'Demo ready' };
  const items = rows.map((e) => {
    const who = e.biz || e.cname || '';
    return '<div class="ev"><span class="ic">' + (ICON[e.type] || '•') + '</span><div class="body"><div class="top"><b>'
      + esc(LABEL[e.type] || e.type) + '</b>' + (who ? ' <span class="who">' + esc(who) + '</span>' : '')
      + '<time>' + esc(ago2(e.created_at)) + ' · ' + esc(String(e.created_at).replace('T', ' ').slice(0, 16)) + ' UTC</time></div>'
      + '<div class="det">' + esc(e.detail || '') + '</div></div></div>';
  }).join('');
  return c.html('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Site activity — Mission Control</title><style>'
    + 'body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#f1f5f9;margin:0;color:#0f172a}'
    + 'header{background:#071B33;color:#fff;padding:14px 24px;display:flex;align-items:center;gap:14px;position:sticky;top:0}'
    + 'header h1{font-size:16px;margin:0}header a{color:#93c5fd;font-size:13px;text-decoration:none;margin-left:auto}'
    + 'main{max-width:860px;margin:22px auto;padding:0 16px}'
    + '.ev{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px 16px;margin-bottom:10px;display:flex;gap:12px}'
    + '.ic{font-size:18px;line-height:1.4}.body{flex:1;min-width:0}'
    + '.top{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;font-size:13.5px}'
    + '.who{color:#334155;background:#eef2f7;border-radius:99px;padding:1px 9px;font-size:11.5px}'
    + 'time{margin-left:auto;color:#94a3b8;font-size:11.5px}'
    + '.det{color:#475569;font-size:12.5px;margin-top:3px;word-break:break-word}'
    + '.empty{color:#94a3b8;text-align:center;padding:40px}'
    + '</style></head><body><header><h1>📜 Site activity</h1><span style="font-size:12px;color:#94a3b8">every edit &amp; publish, newest first</span>'
    + '<a href="/">&larr; Back to Mission Control</a></header><main>'
    + (items || '<div class="empty">No edit or publish activity yet — it starts logging from now.</div>')
    + '</main></body></html>');
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

// Demo-first pitching: create a PROSPECT (no email needed) — the auto-builder
// makes them a one-page demo site before you've ever spoken to them.
app.post('/api/prospects', async (c) => {
  const db = c.env.DB;
  const { business_name, city, email = '', name = '' } = await c.req.json();
  if (!business_name || !String(business_name).trim()) return c.json({ error: 'Business name required' }, 400);
  if (!city || !String(city).trim()) return c.json({ error: 'City required' }, 400);
  const biz = String(business_name).trim(), cty = String(city).trim();
  const placeholderEmail = email.trim() || `prospect+${biz.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}@conversionco918.com`;
  const existing = await db.prepare('SELECT id FROM clients WHERE email = ?').bind(placeholderEmail).first();
  if (existing) return c.json({ error: 'A prospect/client with that email already exists' }, 400);
  // synthesize a minimal intake1 so the demo builder + pitch page read it like a real client
  const intake1 = JSON.stringify({
    'Business Name': biz, 'Contact Name': name || '', 'Email': placeholderEmail,
    'Primary City & State': cty, 'Services Offered': 'IV therapy',
    '_prospect': true, '_created': new Date().toISOString(),
  });
  const r = await db.prepare(`INSERT INTO clients (email, name, business_name, stage, intake1_data) VALUES (?, ?, ?, 'prospect', ?)`)
    .bind(placeholderEmail, name || '', biz, intake1).run();
  const id = r.meta.last_row_id;
  await logEvent(db, id, 'prospect_created', `💡 Prospect added: ${biz} (${cty}) — demo build queued`);
  return c.json({ ok: true, id });
});

// Approve after pricing call -> send Intake 2
// Shared: send Intake 2 (used by the dashboard button AND the after-call automation)
async function sendIntake2Flow(env, db, client, settings) {
  const ghl = ghlFor(env, settings);
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
  await trySMS(ghl, db, client.id, contactId,
    `Hi ${firstName}! ConversionCo here — last step before design starts: your Website Vision form. ${link2}`);
  await touchClient(db, client.id, { stage: 'intake2_sent', ghl_contact_id: contactId });
  await logEvent(db, client.id, 'intake2_sent', `Sent to ${client.email}`);
}

app.post('/api/clients/:id/send-intake2', async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const settings = await getSettings(db);
  try {
    await sendIntake2Flow(c.env, db, client, settings);
    return c.json({ ok: true });
  } catch (e) {
    await logEvent(db, id, 'error', `Intake 2 send failed: ${e.message}`);
    return c.json({ error: e.message }, 502);
  }
});

// 📅 AFTER-CALL AUTOPILOT (Tiffany 7/27): the moment the planning call ends,
// Intake 2 goes out automatically — no waiting on a manual send.
// Polls the GHL booking calendar every 5 min for recently-ended appointments.
// 🌟 REVIEW ENGINE (Tiffany 8/17/2026, five-upgrades #5): ask happy clients for a
// Google review at genuine WIN moments only: a keyword newly on Page 1, their first
// lead, launch day, a lead they marked BOOKED, or the day-30 mark after their deposit.
// LAWS: at most ONE ask per client per QUARTER (revask_<id> flag, written before
// sending so a crash can never double-ask); completely DORMANT until the Google
// Business Profile is verified and settings.review_link is set; never invent urgency;
// the quote-permission line collects verbatim testimonials by reply. Daily noon cron.
async function reviewAskSweep(env) {
  const db = env.DB;
  const settings = await getSettings(db);
  const link = String(settings.review_link || '').trim();
  if (!link) return;
  const clients = (await db.prepare('SELECT * FROM clients').all()).results || [];
  const now = Date.now();
  for (const client of clients) {
    if (!client.email) continue;
    if (!['preview_ready', 'live'].includes(client.stage)) continue;
    const last = Date.parse(settings['revask_' + client.id] || '') || 0;
    if (last && now - last < 90 * 24 * 3600 * 1000) continue;
    let winLine = '';
    try {
      const ev = await db.prepare(`SELECT type, detail FROM events WHERE client_id = ? AND type IN ('page1_celebrated','first_lead_celebrated','launched','lead_booked') AND created_at > datetime('now','-7 days') ORDER BY id DESC LIMIT 1`).bind(client.id).first();
      if (ev) {
        winLine = ev.type === 'page1_celebrated' ? 'We just watched one of your searches hit Page 1 of Google, and it made our week'
          : ev.type === 'first_lead_celebrated' ? 'Your first lead just came in through your website, and it made our week'
          : ev.type === 'lead_booked' ? 'You just booked a customer who found you through your website, and that is exactly why we do this'
          : 'Your website is officially out in the world, and it made our week';
      }
    } catch { /* events hiccup: the day-30 check below still applies */ }
    if (!winLine) {
      const billing = getBilling(client);
      const paidAt = Date.parse(billing.dep_paid_at || billing.paid_at || '') || 0;
      const days = paidAt ? (now - paidAt) / (24 * 3600 * 1000) : 0;
      if (days >= 30 && days <= 40) winLine = 'It has been a month since we started working together, and watching your site grow has been a highlight for us';
    }
    if (!winLine) continue;
    await setSetting(db, 'revask_' + client.id, new Date().toISOString());
    const firstName = String(client.name || '').trim().split(' ')[0] || 'there';
    const html = `<p>Hi ${firstName}!</p>
<p>${winLine}.</p>
<p>Can we ask a small favor while the win is fresh? A quick Google review helps other practitioners like you find us, and it takes about a minute:</p>
<p><a href="${link}" style="display:inline-block;background:#0f172a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Leave ConversionCo a review</a></p>
<p>Prefer to skip the form? Just hit reply with two or three sentences about your experience. And one extra question if you do: are you okay with us putting your words on our website, with your name and business? Totally fine to say no.</p>
<p>Thank you for trusting us with your website!</p>
<p>The ConversionCo Team</p>`;
    await emailClient(env, db, client, settings, 'A quick favor from ConversionCo', html,
      'review_ask_sent', `🌟 Review ask sent to ${client.email} (win: ${winLine.slice(0, 60)}...)`);
  }
}

// \u{1F4EE} REVISION ROUND ONE (Tiffany 8/17/2026): exactly 14 days after a client's FIRST
// payment (the 50% deposit, or a legacy full invoice), send them ONE revisions email.
// Two paths per her design: more than five changes -> type them all in the portal
// (lands in revisionQueue, the revision runner applies them); five or fewer -> book a
// quick call on the Google booking link, or just reply. Copy law: warm, her voice, no
// em dashes, asks the client to BE SPECIFIC. Dedupe flag rev1_sent_<id> is written
// BEFORE sending so a crash can never cause a double-send. The 45-day cap stops the
// feature from blasting long-since-paid clients on its first deploy.
async function revisionRoundOneEmails(env, settings) {
  const db = env.DB;
  const clients = (await db.prepare('SELECT * FROM clients').all()).results || [];
  const now = Date.now();
  for (const client of clients) {
    if (!client.email) continue;
    if (settings['rev1_sent_' + client.id]) continue;
    if (!['preview_ready', 'live'].includes(client.stage)) continue;
    const billing = getBilling(client);
    const paidAt = Date.parse(billing.dep_paid_at || billing.paid_at || '') || 0;
    if (!paidAt) continue;
    const age = now - paidAt;
    if (age < 14 * 24 * 3600 * 1000) continue;
    if (age > 45 * 24 * 3600 * 1000) continue;
    await setSetting(db, 'rev1_sent_' + client.id, new Date().toISOString());
    const firstName = String(client.name || '').trim().split(' ')[0] || 'there';
    const biz = client.business_name || 'your website';
    const portalUrl = `${BASE_URL}/portal/${client.id}/${await portalToken(env, 'portal', client.id)}`;
    const bookLink = settings.booking_link || '';
    const html = `<p>Hi ${firstName}!</p>
<p>It has been two weeks since your ${biz} project kicked off, so it is officially time for your first revision round. This is the part where we polish anything you want changed.</p>
<p><b>One favor that makes a big difference: be specific.</b> "Change the second headline on the home page to say X" gets done exactly right the first time. "Make it pop more" takes us a few guesses. Exact words, exact page, exact spot.</p>
<p><b>If you have more than five changes:</b> open your portal and type them all in one list, one change per line. They go straight to the build team.</p>
<p><a href="${portalUrl}" style="display:inline-block;background:#0f172a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Open your portal</a></p>
<p><b>If you have five or fewer:</b> easiest is a quick call so we can walk through them together${bookLink ? ` <a href="${bookLink}">grab a time here</a>` : ''}. Or just reply to this email with your list, whichever you prefer.</p>
<p>Your package includes two refinement rounds, and this starts round one whenever you are ready.</p>
<p>Talk soon,<br>The ConversionCo Team</p>`;
    await emailClient(env, db, client, settings, `Revision round one for ${biz}: what would you like changed?`, html,
      'rev1_sent', `\u{1F4EE} Revision round one email sent (14 days after first payment) to ${client.email}`);
  }
}

// 📅 GOOGLE MEET WATCHER (8/17/2026) — replaces the GHL calendar poll. Tiffany's
// planning-call booking runs entirely on Google Calendar/Meet now. Uses the same
// GOOGLE_* OAuth secrets as Search Console (refresh token must include the
// calendar.readonly scope). Two jobs per cron tick:
//   1. Upcoming booked calls -> settings meet_<clientId> so the dashboard card can
//      show "Call booked: <day/time>" with the Meet link.
//   2. After-call autopilot: a call that ENDED and matches a client who has not done
//      Intake 2 -> send Intake 2 automatically (same gates + dedupe as before).
async function pollGoogleMeet(env, settings) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) return;
  const db = env.DB;
  const now = Date.now();
  const throttleErr = async (msg) => {
    const last = Number(settings.appt_poll_err || 0);
    if (now - last > 6 * 3600 * 1000) {
      await setSetting(db, 'appt_poll_err', String(now));
      await logEvent(db, null, 'error', msg);
    }
  };
  let token = '';
  try {
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' }),
    });
    const td = await tr.json();
    token = td.access_token || '';
    if (!token) throw new Error(td.error_description || td.error || 'no access token');
  } catch (e) {
    await throttleErr(`After-call autopilot: Google sign-in failed (${String(e.message).slice(0, 80)}) — Intake 2 auto-send paused; manual send still works`);
    return;
  }
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  url.searchParams.set('timeMin', new Date(now - 48 * 3600 * 1000).toISOString());
  url.searchParams.set('timeMax', new Date(now + 60 * 24 * 3600 * 1000).toISOString());
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '100');
  const res = await fetch(url.toString(), { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) {
    await throttleErr(`After-call autopilot: Google Calendar poll failed (${res.status}) — Intake 2 auto-send paused; manual send still works. If this says 403, the refresh token is missing the calendar.readonly scope.`);
    return;
  }
  const data = await res.json().catch(() => ({}));
  const events = data.items || [];
  const clients = (await db.prepare('SELECT * FROM clients').all()).results || [];
  const byEmail = {};
  for (const cl of clients) { if (cl.email) byEmail[String(cl.email).toLowerCase().trim()] = cl; }
  const upcoming = {};
  for (const ev of events) {
    if (String(ev.status || '') === 'cancelled') continue;
    const startT = Date.parse((ev.start && (ev.start.dateTime || ev.start.date)) || 0) || 0;
    const endT = Date.parse((ev.end && (ev.end.dateTime || ev.end.date)) || 0) || 0;
    let client = null;
    for (const a of (ev.attendees || [])) {
      const em = String(a.email || '').toLowerCase().trim();
      if (em && byEmail[em]) { client = byEmail[em]; break; }
    }
    if (!client) continue;
    const vid = (ev.conferenceData && ev.conferenceData.entryPoints || []).find((p) => p.entryPointType === 'video');
    const link = ev.hangoutLink || (vid && vid.uri) || '';
    if (startT > now) {
      const cur = upcoming[client.id];
      if (!cur || startT < cur.at) upcoming[client.id] = { at: startT, end: endT, link, summary: String(ev.summary || '').slice(0, 80) };
      continue;
    }
    if (!endT || endT > now) continue;
    const evId = String(ev.id || '');
    if (!evId || settings['appt_done_' + evId]) continue;
    await setSetting(db, 'appt_done_' + evId, new Date().toISOString());
    if (!['new', 'intake1_sent', 'intake1_done'].includes(client.stage)) continue;
    if (client.intake2_data && client.intake2_data.length > 2) continue;
    try {
      await sendIntake2Flow(env, db, client, settings);
      await logEvent(db, client.id, 'intake2_sent', `🤖 Planning call ended — Intake 2 sent automatically to ${client.email}`);
    } catch (e) {
      await logEvent(db, client.id, 'error', `After-call Intake 2 auto-send failed: ${String(e.message).slice(0, 140)}`);
    }
  }
  for (const cl of clients) {
    const key = 'meet_' + cl.id;
    const up = upcoming[cl.id];
    if (up) {
      await setSetting(db, key, JSON.stringify({ at: new Date(up.at).toISOString(), end: up.end ? new Date(up.end).toISOString() : '', link: up.link, summary: up.summary }));
    } else if (settings[key]) {
      let old = null; try { old = JSON.parse(settings[key]); } catch {}
      const oldEnd = (old && Date.parse(old.end || old.at)) || 0;
      if (!oldEnd || oldEnd < now - 2 * 3600 * 1000) await setSetting(db, key, '');
    }
  }
}
async function pollAppointments(env, settings) {
  if (!env.GHL_TOKEN || !settings.ghl_location_id) return;
  const db = env.DB;
  const calId = settings.booking_calendar_id || 'kfZNB7wOmwHcy769nGh3';
  const now = Date.now();
  const url = new URL('https://services.leadconnectorhq.com/calendars/events');
  url.searchParams.set('locationId', settings.ghl_location_id);
  url.searchParams.set('calendarId', calId);
  url.searchParams.set('startTime', String(now - 48 * 3600 * 1000));
  url.searchParams.set('endTime', String(now));
  const res = await fetch(url.toString(), { headers: {
    Authorization: `Bearer ${env.GHL_TOKEN}`, Version: '2021-04-15', Accept: 'application/json' } });
  if (!res.ok) {
    const last = Number(settings.appt_poll_err || 0);
    if (now - last > 6 * 3600 * 1000) {
      await setSetting(db, 'appt_poll_err', String(now));
      await logEvent(db, null, 'error', `After-call autopilot: calendar poll failed (${res.status}) — Intake 2 auto-send paused; manual send still works`);
    }
    return;
  }
  const data = await res.json().catch(() => ({}));
  const events = data.events || data.data || [];
  for (const ev of events) {
    const evId = ev.id || ev.eventId || '';
    const endT = Date.parse(ev.endTime || ev.end_time || 0) || Number(ev.endTime) || 0;
    const status = String(ev.appointmentStatus || ev.appoinmentStatus || ev.status || '').toLowerCase();
    if (!evId || !endT || endT > now) continue; // only ENDED appointments
    if (['cancelled', 'canceled', 'noshow', 'no-show', 'invalid'].includes(status)) continue;
    if (settings[`appt_done_${evId}`]) continue; // handled already
    await setSetting(db, `appt_done_${evId}`, new Date().toISOString());
    // match the appointment to a client: contact id first, then email lookup
    let client = null;
    const contactId = ev.contactId || ev.contact_id || '';
    if (contactId) client = await db.prepare('SELECT * FROM clients WHERE ghl_contact_id = ?').bind(contactId).first();
    if (!client && contactId) {
      try {
        const ghl = ghlFor(env, settings);
        const contact = await ghl.getContact(contactId);
        const cEmail = (contact?.contact?.email || contact?.email || '').toLowerCase().trim();
        if (cEmail) client = await db.prepare('SELECT * FROM clients WHERE lower(email) = ?').bind(cEmail).first();
      } catch { /* contact lookup best-effort */ }
    }
    if (!client) continue;
    // only clients who haven't gotten/done Intake 2 yet
    if (!['new', 'intake1_sent', 'intake1_done'].includes(client.stage)) continue;
    if (client.intake2_data && client.intake2_data.length > 2) continue;
    try {
      await sendIntake2Flow(env, db, client, settings);
      await logEvent(db, client.id, 'intake2_sent', `🤖 Planning call ended — Intake 2 sent automatically to ${client.email}`);
    } catch (e) {
      await logEvent(db, client.id, 'error', `After-call Intake 2 auto-send failed: ${String(e.message).slice(0, 140)}`);
    }
  }
}


// Manual stage change / notes / delete
app.patch('/api/clients/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json();
  const allowed = {};
  for (const k of ['stage', 'notes', 'name', 'phone', 'business_name', 'preview_url', 'live_url', 'theme', 'tier', 'launch_checklist', 'vibe', 'email', 'competitors']) {
    if (k in body) allowed[k] = body[k];
  }
  if (!Object.keys(allowed).length) return c.json({ error: 'nothing to update' }, 400);
  // 🚀 LAUNCH DAY: first time the site goes live (stage=live or live_url set), make it an event.
  // quietLaunch:true = imported/already-live client — record the launch state, skip the email.
  const quietLaunch = body.quietLaunch === true;
  const before = await c.env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  const goingLive = before && ((allowed.stage === 'live' && before.stage !== 'live') || (allowed.live_url && !before.live_url));
  await touchClient(c.env.DB, id, allowed);
  if (goingLive) {
    let bL = {}; try { bL = JSON.parse(before.billing || '{}'); } catch {}
    if (bL.launched_at || quietLaunch) {
      if (!bL.launched_at) { bL.launched_at = new Date().toISOString(); await touchClient(c.env.DB, id, { billing: JSON.stringify(bL) }); }
      if (quietLaunch) await logEvent(c.env.DB, id, 'launched', `🚀 ${before.business_name || before.name || before.email} imported as LIVE (quiet — no launch email)`);
    } else {
      bL.launched_at = new Date().toISOString();
      await touchClient(c.env.DB, id, { billing: JSON.stringify(bL) });
      const settingsL = await getSettings(c.env.DB);
      const firstL = (before.name || '').split(' ')[0] || 'there';
      const site = allowed.live_url || before.live_url || '';
      const purlL = `${BASE_URL}/portal/${id}/${await portalToken(c.env, 'portal', id)}`;
      await logEvent(c.env.DB, id, 'launched', `🚀 LAUNCH DAY — ${before.business_name || before.name || before.email} is live${site ? ' at ' + site : ''}`);
      await emailClient(c.env, c.env.DB, before, settingsL,
        `You're live. 🚀`,
        `<p>${firstL} — today's the day.</p>
<p><b>${before.business_name || 'Your business'} is officially live on the internet${site ? ` at ${site}` : ''}.</b> Google has been told where to find you, your daily protection checks are running, and starting this week we track <b>what page of Google you're on</b> — you'll see it in your portal and in every report.</p>
<p>Here's your window into all of it:</p><p><a href="${purlL}">${purlL}</a></p>
<p>Thirty days from now, we'll show you a before-and-after. Welcome to the climb.</p>
<p>— The ConversionCo Team</p>`,
        'launch_emailed', '🚀 Launch-day email sent');
    }
    // 📡 INSTANT Search Console enrollment — Google gets the map the moment a site
    // goes live (property + verification + sitemap). Sunday's pull is the safety net.
    try {
      const afterCl = await c.env.DB.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
      const settingsG = await getSettings(c.env.DB);
      c.executionCtx.waitUntil(gscEnsureClient(c.env, settingsG, afterCl).then((r) => {
        if (r) return logEvent(c.env.DB, id, 'gsc_enroll_kickoff', `📡 Search Console enrollment ran at go-live for ${r.domain}${r.st.verified ? ' — verified ✓' : ' — verification pending (auto-retries every Sunday)'}`);
      }).catch(() => {}));
    } catch { /* Sunday safety net covers it */ }
  }
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
  // 8/17 GUARD: deleting a card mid-build orphans the site + the signed agreement.
  const clD = await c.env.DB.prepare('SELECT stage FROM clients WHERE id = ?').bind(id).first();
  if (clD && clD.stage === 'generating' && c.req.query('force') !== 'yes')
    return c.json({ error: 'A build is RUNNING for this client. Deleting now would orphan the site and the signed agreement. Wait for the build to finish (or re-request with ?force=yes).' }, 409);
  await c.env.DB.prepare('DELETE FROM clients WHERE id = ?').bind(id).run();
  // 8/19: sweep this client's per-client settings so nothing keeps running for a
  // card that no longer exists (the ads watchdog used to keep polling dead pages).
  try {
    await c.env.DB.prepare(
      `DELETE FROM settings WHERE key IN (${['ads', 'gsc', 'gsc_data', 'gsc_first', 'buildprog', 'uptime', 'meet', 'qw_build', 'rev1_sent', 'revask', 'lp'].map(() => '?').join(',')})`
    ).bind(...['ads', 'gsc', 'gsc_data', 'gsc_first', 'buildprog', 'uptime', 'meet', 'qw_build', 'rev1_sent', 'revask', 'lp'].map((p) => `${p}_${id}`)).run();
    await c.env.DB.prepare('DELETE FROM rank_history WHERE client_id = ?').bind(id).run();
  } catch { /* cleanup is best-effort — never block the delete */ }
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
  let planKey = 'hosting';
  try { planKey = (await c.req.json())?.plan || 'hosting'; } catch {}
  if (!['hosting', 'care199', 'care399'].includes(planKey)) planKey = 'hosting';
  try {
    const cust = await ensureCustomer(c.env.STRIPE_SECRET_KEY, client.email, client.name || client.business_name || '');
    const ret = client.live_url || client.preview_url || 'https://conversionco918.com';
    const sess = await hostingCheckout(c.env.STRIPE_SECRET_KEY, cust.id, client.business_name || '', ret, planKey);
    const billing = getBilling(client);
    billing.customer_id = cust.id;
    billing.sub_session_id = sess.id; billing.sub_link = sess.url; billing.sub_status = 'pending'; billing.sub_plan = planKey;
    await touchClient(db, id, { billing: JSON.stringify(billing) });
    await logEvent(db, id, 'hosting_link', `${PRICES[planKey].label} (${PRICES[planKey].display}) — checkout link created 🔒`);
    return c.json({ ok: true, url: sess.url, plan: planKey });
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
          await logEvent(db, client.id, 'hosting_active', 'Hosting & security $$99/mo ACTIVE 🔒✅');
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
  const { what, quiet } = await c.req.json();
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
    await logEvent(db, id, 'invoice_paid', `50% deposit marked PAID manually (bypass — paid outside Stripe) 🔓💰 — build unlocked${quiet ? ' (quiet: no portal email)' : ''}`);
    if (!quiet) {
      const settingsB = await getSettings(db);
      await sendPortalEmail(c.env, db, client, settingsB);
    }
  }
  await touchClient(db, id, { billing: JSON.stringify(billing) });
  return c.json({ ok: true });
});

// 🌐 GO-LIVE AUTOPILOT: attach a client's domain to direct hosting — zone check,
// Workers custom domains for apex + www (DNS + SSL automatic), live-host serving
// mapping, optional hello@ email forward, card flipped live + instant GSC.
// ══ LAUNCH GATE — audit what the live domain ACTUALLY serves ═══════════════
// The pre-launch audit on 8/20 passed cleanly and the site still launched with
// every image broken. Why: the audit read the PREVIEW url, where the paths were
// correct. The bug only existed on the live domain.
//
// The obvious fix — have the worker fetch https://theirdomain.com — does NOT
// work, and finding that out cost a deploy: once a domain is attached to this
// worker, the worker fetching that domain is the worker calling itself, and
// Cloudflare answers 522 for every page. A green check built that way would be
// all-red on a perfectly healthy site, and (worse) an all-green one on a broken
// site the day that behaviour changes.
//
// So this checks the three things that can independently make a launch wrong,
// each from the one source that actually knows:
//   1. SERVING  — settings say both hostnames map to this client's site
//   2. DNS/SSL  — Cloudflare says both hostnames are attached with a live cert
//   3. CONTENT  — the served file rows (the literal bytes the domain returns)
//                 contain no /preview/ paths, and every image they reference
//                 exists as a real file in that site
// Then it hands the browser a short list of live URLs to probe from OUTSIDE
// Cloudflare — an independent pair of eyes the worker cannot provide itself.
app.get('/api/clients/:id/launch-check', async (c) => {
  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ ok: false, error: 'client not found' }, 404);
  let domain = String(c.req.query('domain') || '');
  if (!domain) { try { domain = new URL(client.live_url).hostname; } catch {} }
  domain = domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (!domain) return c.json({ ok: false, error: 'no live domain on this client yet' }, 400);

  const slug = await slugForClient(db, id);
  if (!slug) return c.json({ ok: false, error: 'no built site for this client yet' }, 400);
  const problems = [], notes = [];

  // ── 1. SERVING ───────────────────────────────────────────────────────────
  const settings = await getSettings(db);
  for (const host of [domain, `www.${domain}`]) {
    const mapped = settings[`livehost_${host}`];
    if (mapped === slug) notes.push(`${host} → ${slug} ✓`);
    else if (mapped) problems.push(`${host} is serving a different site (${mapped}), not this client's`);
    else problems.push(`${host} is not mapped to any site — it will not serve`);
  }

  // ── 2. DNS + SSL, straight from Cloudflare ───────────────────────────────
  let certsOk = null;
  if (c.env.CLOUDFLARE_API_TOKEN && c.env.CF_ACCOUNT_ID) {
    try {
      const cf = async (p) => (await fetch(`https://api.cloudflare.com/client/v4${p}`, {
        headers: { Authorization: `Bearer ${c.env.CLOUDFLARE_API_TOKEN}` } })).json();
      const doms = await cf(`/accounts/${c.env.CF_ACCOUNT_ID}/workers/domains?hostname=${encodeURIComponent(domain)}`);
      const all = await cf(`/accounts/${c.env.CF_ACCOUNT_ID}/workers/domains`);
      const owned = ((all && all.result) || []).filter((d) => d.hostname === domain || d.hostname === `www.${domain}`);
      certsOk = owned.length >= 2;
      for (const host of [domain, `www.${domain}`]) {
        const hit = owned.find((d) => d.hostname === host);
        if (!hit) problems.push(`${host} is not attached to the site in Cloudflare — DNS still points somewhere else`);
        else if (hit.service && hit.service !== 'conversionco-mission-control')
          problems.push(`${host} is attached to the wrong worker (${hit.service})`);
        else notes.push(`${host} attached in Cloudflare ✓`);
      }
      if (doms && doms.errors && doms.errors.length) notes.push('cloudflare: ' + JSON.stringify(doms.errors).slice(0, 120));
    } catch (e) { notes.push('could not read Cloudflare (check skipped): ' + String(e && e.message || e).slice(0, 80)); }
  } else notes.push('Cloudflare token not configured — DNS/SSL check skipped');

  // ── 3. CONTENT — the actual served bytes ─────────────────────────────────
  const rows = (await db.prepare('SELECT path, content FROM site_files WHERE slug = ?').bind(slug).all()).results || [];
  const have = new Set(rows.map((r) => String(r.path)));
  const htmlRows = rows.filter((r) => /\.(html|css|js)$/i.test(String(r.path)));
  let previewPages = 0, missingImgs = [], imgRefs = 0;
  const probeImgs = new Set(), probePages = new Set();
  for (const r of htmlRows) {
    const body = String(r.content || '');
    if (body.includes('/preview/')) { previewPages++; problems.push(`${r.path} still contains preview-only paths (/preview/…) — those 404 on the live domain`); }
    const re = /(?:src|href|poster)="([^"]+\.(?:png|jpe?g|webp|svg|gif))"|url\((['"]?)([^)'"]+\.(?:png|jpe?g|webp|svg|gif))\2\)/gi;
    let m;
    while ((m = re.exec(body))) {
      let ref = m[1] || m[3] || '';
      if (/^(https?:)?\/\//i.test(ref) || ref.startsWith('data:')) continue;
      imgRefs++;
      const clean = ref.replace(/^\.\//, '').replace(/^\//, '').split('?')[0];
      if (!have.has(clean)) missingImgs.push(`${r.path} → ${ref}`);
      else if (probeImgs.size < 6) probeImgs.add(clean);
    }
    if (/\.html$/i.test(String(r.path)) && probePages.size < 6) probePages.add(String(r.path));
  }
  if (missingImgs.length) {
    const uniq = [...new Set(missingImgs.map((x) => x.split('→')[1].trim()))];
    problems.push(`${missingImgs.length} image reference${missingImgs.length === 1 ? '' : 's'} point at files that do not exist in this site: ${uniq.slice(0, 6).join(', ')}${uniq.length > 6 ? ` (+${uniq.length - 6} more)` : ''}`);
  }

  // ── the browser's half: real URLs to load from outside Cloudflare ────────
  const base = `https://${domain}`;
  const probe = {
    images: [...probeImgs].map((p) => `${base}/${p}`),
    pages: [...probePages].map((p) => `${base}/${p === 'index.html' ? '' : p}`),
    www: `https://www.${domain}/`,
  };

  const pass = problems.length === 0;
  // A passing gate is proof of health, so it clears any stale DOWN alarm — the
  // self-fetch bug left client cards flagged red on sites that were perfectly up.
  if (pass) {
    try {
      let st = {}; try { st = JSON.parse(settings[`uptime_${id}`] || '{}'); } catch {}
      if (st.last === 'down') { st.last = 'up'; st.how = 'launch check passed'; st.at = new Date().toISOString(); await setSetting(db, `uptime_${id}`, JSON.stringify(st)); }
      if (settings[`downwatch_${id}`] && settings[`downwatch_${id}`] !== '{}') await setSetting(db, `downwatch_${id}`, '{}');
    } catch { /* clearing an alarm must never fail the check */ }
  }
  await logEvent(db, id, pass ? 'launch_check_pass' : 'launch_check_fail',
    pass ? `✅ Launch check passed on ${domain}: ${htmlRows.length} served files clean, ${imgRefs} image refs all resolve, hostnames mapped + attached.`
         : `⚠️ Launch check found ${problems.length} problem(s) on ${domain}: ${problems.slice(0, 3).join(' · ')}`);
  return c.json({
    ok: pass, domain, slug,
    files_checked: htmlRows.length, preview_pages: previewPages,
    image_refs: imgRefs, images_missing: missingImgs.length,
    hostnames_attached: certsOk, notes, problems, probe,
  });
});

// ══ AEO ENGINE ═════════════════════════════════════════════════════════════
// "Is my business showing up when people ask an AI?" — answered with measured
// data, not vibes. Three things are reported and never blended:
//   1. AI traffic     — answer-fetches, referral visits, training crawls
//   2. AI revenue     — leads whose first touch was an AI answer, and what they booked
//   3. Readiness /100 — what is actually stopping the site being cited, with fixes
//
// The audit reads the site's OWN served rows (the literal bytes the domain
// returns) rather than fetching the domain, for the same reason the launch gate
// does: a worker cannot fetch a hostname it is serving. robots.txt is the one
// exception — Cloudflare injects a managed block at the edge that never appears
// in the stored file — so that one is checked from the browser instead.

// What actually gets a business cited by an answer engine.
//
// The first version of this scored Anywhere Infusions at 93/100 while the site
// had one sameAs link, no entity graph, no opening hours, no dateModified, and
// not a single paragraph long enough for an engine to quote. A score that reads
// "nearly perfect" over gaps that size is worse than no score — it tells you to
// stop working. So the dimensions below are the ones a real audit turned up.
//
// 100 points: 30 access (scored in the browser, see the endpoint) + 70 here.
function aeoAudit(rows, biz, opts = {}) {
  const have = new Map(rows.map((r) => [String(r.path), String(r.content || '')]));
  const htmls = [...have.entries()].filter(([p]) => /\.html$/i.test(p));
  const all = htmls.map(([, c]) => c).join('\n');
  const wins = [], fixes = [];
  let score = 0;
  const add = (pts, ok, win, fix) => { if (ok) { score += pts; wins.push(win); } else fixes.push({ pts, ...fix }); };

  // ── parse every JSON-LD node once ───────────────────────────────────────
  const nodes = [];
  for (const raw of all.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(raw[1]);
      for (const n of (Array.isArray(j) ? j : [j, ...(j['@graph'] || [])])) if (n && typeof n === 'object') nodes.push(n);
    } catch { /* malformed blocks are counted as absent, which is the finding */ }
  }
  const types = new Set();
  for (const n of nodes) if (n['@type']) [].concat(n['@type']).forEach((t) => types.add(String(t)));
  const LOCAL = ['LocalBusiness', 'MedicalBusiness', 'HealthAndBeautyBusiness', 'MedicalClinic', 'Physician', 'Organization', 'DaySpa'];
  const bizNode = nodes.find((n) => [].concat(n['@type'] || []).some((t) => LOCAL.includes(String(t)))) || null;

  // ══ ENTITY & STRUCTURED DATA — 30 ══════════════════════════════════════
  add(8, !!bizNode,
    'Business identity is machine-readable (LocalBusiness schema)',
    { what: 'Add LocalBusiness schema with name, address, phone and hours', why: 'Without it an engine cannot confirm this is a real local business, and names a competitor that has it.' });

  add(6, !!(bizNode && bizNode['@id']),
    'One canonical business entity — every page points at the same business',
    { what: 'Give the business a single @id and have every page reference it', why: 'Otherwise each page declares its own separate business, so 50 pages read as 50 unlinked mentions instead of one company with 50 pages.' });

  const sameAs = [].concat((bizNode && bizNode.sameAs) || []).filter(Boolean);
  add(8, sameAs.length >= 3,
    `Linked to ${sameAs.length} off-site profiles — the website, listings and socials resolve to one business`,
    { what: sameAs.length ? `Only ${sameAs.length} off-site profile linked — add Google Business Profile, Facebook, Yelp and the rest` : 'Link the off-site profiles (Google Business Profile, Facebook, Instagram, Yelp) via sameAs',
      why: 'sameAs is how an engine proves the Yelp listing, the Google listing and this website are the same company. It is also what makes every new listing you create count.' });

  add(4, types.has('FAQPage'),
    'FAQ schema present — engines can lift Q&A directly',
    { what: 'Add FAQPage schema to the FAQ and service pages', why: 'FAQ schema is the most-quoted format in AI answers.' });

  // ══ QUOTABLE CONTENT — 20 ══════════════════════════════════════════════
  // The measured sweet spot for a passage an engine will lift is ~50-150 words
  // that stand alone. Marketing copy is almost never in that range.
  let quotable = 0, paras = 0;
  for (const [, c] of htmls) {
    const body = c.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
    for (const m of body.matchAll(/<(p|li|dd)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
      const w = m[2].replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').trim().split(/\s+/).filter(Boolean).length;
      if (w > 3) { paras++; if (w >= 50 && w <= 150) quotable++; }
    }
  }
  // also count schema FAQ answers — those are quoted straight out of the markup
  let faqLong = 0, faqTotal = 0;
  for (const n of nodes) for (const e of [].concat(n.mainEntity || [])) {
    const t = e && e.acceptedAnswer && e.acceptedAnswer.text;
    if (t) { faqTotal++; const w = String(t).split(/\s+/).filter(Boolean).length; if (w >= 50 && w <= 150) faqLong++; }
  }
  const quotableTotal = quotable + faqLong;
  add(11, quotableTotal >= Math.max(10, htmls.length * 0.3),
    `${quotableTotal} self-contained 50–150 word passages an engine can quote`,
    { what: quotableTotal ? `Only ${quotableTotal} passages are in the 50–150 word range engines quote (of ${paras + faqTotal} checked)` : `Not one passage on the site is in the 50–150 word range engines quote (${paras + faqTotal} checked)`,
      why: 'Short punchy marketing copy converts humans and gives an engine nothing to lift. This does not mean changing the voice — it means adding one self-contained answer under each question.' });

  const qHeads = (all.match(/<h[23][^>]*>[^<]*\?/gi) || []).length + faqTotal;
  add(7, qHeads >= 20,
    `${qHeads} questions answered on the site`,
    { what: qHeads >= 8 ? `Only ${qHeads} questions answered — aim for 20+ real customer questions` : 'Write content as real customer questions with a direct answer underneath',
      why: 'Engines match a user question to a question on the page, then quote what sits under it.' });

  // ══ MACHINE-READABLE FACTS — 10 ════════════════════════════════════════
  const NON_SERVICE = /^(index|about|faq|blog|privacy|privacy-policy|legal|legal-terms|terms|review|review-us|safety|safety-standards|locations|membership|contact|thanks|thank-you|404|sitemap)\b/i;
  const svcPages = htmls.filter(([p]) => !NON_SERVICE.test(p) && !/^(blog-|iv-therapy-|city-)/i.test(p));
  const noPrice = svcPages.filter(([, c]) => !/"offers"|"priceSpecification"/i.test(c)).map(([p]) => p);
  add(4, svcPages.length > 0 && noPrice.length === 0,
    `All ${svcPages.length} service pages carry a machine-readable price`,
    { what: `${noPrice.length} service page(s) have no machine-readable price: ${noPrice.slice(0, 4).join(', ')}${noPrice.length > 4 ? ` (+${noPrice.length - 4})` : ''}`,
      why: 'A price an engine cannot read is a price it will not quote — and cost is the most common question asked about a service.' });

  add(2, !!(bizNode && bizNode.openingHoursSpecification),
    'Opening hours are machine-readable',
    { what: 'Add opening hours to the business schema', why: '"Are they open now" and "can someone come tonight" are among the most asked questions about a local service, and the answer is currently not readable anywhere.' });

  const dm = htmls.filter(([, c]) => /"dateModified"/.test(c)).length;
  add(2, dm >= htmls.length * 0.6,
    'Pages declare when they were last updated',
    { what: `Only ${dm} of ${htmls.length} pages declare a last-updated date`, why: 'Freshness is a real input, and right now most of the site declares none.' });

  // ══ DISCOVERABILITY — 10 ══════════════════════════════════════════════
  // A page nothing links to and no sitemap lists is invisible, however good it
  // is. On Anywhere this was hiding a whole published blog post and six service
  // landing pages — pages that had been paid for and written and could not be
  // found by anything.
  const sitemap = have.get('sitemap.xml') || '';
  const listed = new Set([...sitemap.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)]
    .map((m) => (m[1].replace(/\/$/, '').split('/').pop() || 'index.html')));
  const IGNORE = /^(404|sitemap)/i;
  const linkTargets = new Set([...all.matchAll(/href=["']([^"'#?]+\.html)["']/gi)].map((m) => m[1].split('/').pop()));
  const orphans = htmls.map(([p]) => p).filter((p) => !IGNORE.test(p)
    && !listed.has(p) && !listed.has(p.replace(/index\.html$/, '')) && !linkTargets.has(p));
  add(6, sitemap && orphans.length === 0,
    sitemap ? 'Every page is reachable — listed in the sitemap or linked from the site' : 'sitemap present',
    { what: sitemap ? `${orphans.length} page(s) are invisible — not in the sitemap and not linked from anywhere: ${orphans.slice(0, 5).join(', ')}${orphans.length > 5 ? ` (+${orphans.length - 5})` : ''}` : 'No sitemap.xml — nothing can discover the pages systematically',
      why: 'Crawlers find pages through links and the sitemap. A page in neither has been written and paid for and cannot be found by anything.' });

  // Two URLs serving the same page split the credit and leave an engine unsure
  // which one is the real address.
  const sig = new Map();
  for (const [p, c] of htmls) {
    const t = ((c.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').trim().toLowerCase();
    if (!t || IGNORE.test(p)) continue;
    if (!sig.has(t)) sig.set(t, []);
    sig.get(t).push(p);
  }
  const dupes = [...sig.values()].filter((v) => v.length > 1);
  add(4, dupes.length === 0,
    'No duplicate pages — every page lives at exactly one address',
    { what: `${dupes.length} page(s) exist at two addresses: ${dupes.slice(0, 3).map((v) => v.join(' = ')).join('; ')}`,
      why: 'The same page at two URLs splits its credit and leaves an engine unsure which is the real address. Pick one and redirect the other.' });

  // ══ HYGIENE — 10 ═══════════════════════════════════════════════════════
  add(3, have.has('llms.txt') && (have.get('llms.txt') || '').length > 200,
    'llms.txt present — the site explains itself to models in plain language',
    { what: 'Publish an llms.txt', why: 'A plain-text brief of the business, services and area that models read directly. One click to generate.' });

  const idx = have.get('index.html') || '';
  const text = idx.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  add(2, text.length > 1200,
    'Home page content lives in the HTML, not in JavaScript',
    { what: 'Home page has little readable text in the raw HTML', why: 'AI crawlers do not run JavaScript. Whatever is not in the HTML does not exist to them.' });

  const phones = new Set();
  for (const m of all.matchAll(/href=["']tel:\+?1?([0-9][0-9\-.() ]{8,})["']/gi)) phones.add(m[1].replace(/\D/g, '').replace(/^1/, ''));
  for (const m of all.matchAll(/"telephone"\s*:\s*"\+?1?([^"]+)"/gi)) phones.add(m[1].replace(/\D/g, '').replace(/^1/, ''));
  phones.delete('');
  const nameHits = biz ? htmls.filter(([, c]) => c.toLowerCase().includes(String(biz).toLowerCase())).length : 0;
  add(3, phones.size === 1 && (!biz || nameHits >= htmls.length * 0.8),
    'Business name and phone number are identical on every page',
    { what: `Make the business details identical everywhere — ${[phones.size > 1 ? `${phones.size} different phone numbers appear` : '', biz && nameHits < htmls.length * 0.8 ? `the name is missing from ${htmls.length - nameHits} page(s)` : ''].filter(Boolean).join(' and ')}`,
      why: 'Conflicting details make an engine unsure it is one business, so it stays quiet rather than risk being wrong.' });

  fixes.sort((a, b) => b.pts - a.pts);
  return { score, max: 70, wins, fixes, pages: htmls.length,
    questions: qHeads, quotable: quotableTotal, same_as: sameAs.length,
    has_entity_id: !!(bizNode && bizNode['@id']), schema_types: [...types] };
}

app.get('/api/clients/:id/aeo', async (c) => {
  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'client not found' }, 404);
  const slug = await slugForClient(db, id);
  const days = Math.min(365, Math.max(7, Number(c.req.query('days') || 28)));

  // ── 1. traffic, split three ways and never summed
  let traffic = { answer: [], referral: [], train: [], totals: { answer: 0, referral: 0, train: 0 } };
  if (slug) {
    const rows = (await db.prepare(
      `SELECT engine, kind, SUM(n) AS n FROM ai_visits
       WHERE slug = ? AND day > date('now', ?) GROUP BY engine, kind ORDER BY n DESC`
    ).bind(slug, `-${days} days`).all()).results || [];
    for (const r of rows) {
      const k = String(r.kind);
      if (!traffic[k]) continue;
      traffic[k].push({ engine: r.engine, n: Number(r.n) });
      traffic.totals[k] += Number(r.n);
    }
  }

  // ── 2. money: leads whose first touch was an AI answer
  const leadRows = (await db.prepare(
    `SELECT id, name, email, referrer, utm_source, status, value, created_at
     FROM leads WHERE client_id = ? AND created_at > datetime('now', ?)`
  ).bind(id, `-${days} days`).all()).results || [];
  const aiLeads = [];
  for (const l of leadRows) {
    const engine = aiReferral(l.referrer, l.utm_source);
    if (engine) aiLeads.push({ id: l.id, name: l.name || l.email || 'lead', engine, status: l.status || '', value: Number(l.value || 0), at: l.created_at });
  }
  const booked = aiLeads.filter((l) => l.status === 'booked');
  const money = {
    leads: aiLeads.length,
    booked: booked.length,
    revenue: booked.reduce((a, l) => a + l.value, 0),
    all_leads: leadRows.length,
  };

  // ── 3. readiness — content side here, crawler access from the browser
  const fileRows = slug ? ((await db.prepare(
    `SELECT path, content FROM site_files WHERE slug = ? AND (path LIKE '%.html' OR path IN ('llms.txt','sitemap.xml'))`
  ).bind(slug).all()).results || []) : [];
  // business_name only — falling back to the contact's first name would check
  // every page for "Tiffany" and report a nonsense finding.
  const audit = aeoAudit(fileRows, client.business_name || '');

  // the browser fetches robots.txt for us — Cloudflare's managed block is injected
  // at the edge and is not in the stored file, and we cannot fetch our own domain
  let domain = '';
  try { domain = new URL(client.live_url).hostname.replace(/^www\./, ''); } catch {}

  let profiles = {}; try { profiles = JSON.parse(client.profiles || '{}'); } catch {}
  let hours = []; try { hours = JSON.parse(client.hours || '[]'); } catch {}
  return c.json({
    ok: true, client_id: id, slug, domain, days,
    traffic, money, audit, profiles, hours,
    robots_url: domain ? `https://${domain}/robots.txt` : '',
    note: 'access score (30 pts) is added by the browser after it reads robots.txt',
  });
});

// ══ ONE-CLICK ENTITY FIX ═══════════════════════════════════════════════════
// Welds a whole site into a single business entity an answer engine can trust.
//
// It does NOT rewrite the JSON-LD already on the page — editing 50 files of
// someone else's markup programmatically is how you break a live site. Instead
// it injects ONE additional block carrying a canonical @graph. Schema.org merges
// nodes by @id, so the existing per-page schema and this block combine rather
// than fight. Running it twice replaces its own block and changes nothing else.
const CC_ENTITY_TAG = 'cc-entity';

function buildEntityGraph(client, domain, profiles, hours, pagePath, pageHtml, updatedAt) {
  const base = `https://${domain}`;
  const biz = client.business_name || client.name || domain;
  const bizId = `${base}/#business`;
  const siteId = `${base}/#website`;
  const pageUrl = pagePath === 'index.html' ? `${base}/` : `${base}/${pagePath}`;

  const sameAs = Object.values(profiles || {}).map((v) => String(v || '').trim()).filter((v) => /^https?:\/\//i.test(v));

  // Read the facts already proven on the page rather than inventing them.
  const tel = (pageHtml.match(/href=["']tel:\+?1?([0-9][0-9\-.() ]{8,})["']/i) || [])[1] || '';
  const phone = tel ? '+1' + tel.replace(/\D/g, '').replace(/^1/, '') : '';
  const title = ((pageHtml.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').trim();
  const desc = ((pageHtml.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i) || [])[1] || '').trim();
  const img = ((pageHtml.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i) || [])[1] || '').trim();

  // Reuse whatever the site already declares — never contradict it.
  let prior = {};
  for (const raw of pageHtml.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(raw[1]);
      for (const n of (Array.isArray(j) ? j : [j, ...(j['@graph'] || [])])) {
        if (n && /Business|Organization|Clinic|Physician/i.test(String(n['@type'] || ''))) prior = { ...n, ...prior };
      }
    } catch {}
  }

  const areaServed = [].concat(prior.areaServed || []).map((a) => {
    if (typeof a !== 'string') return a;
    const [city, region] = a.split(',').map((x) => x.trim());
    return { '@type': 'City', name: city, ...(region ? { addressRegion: region } : {}), addressCountry: 'US' };
  });

  const bizNode = {
    '@type': prior['@type'] || 'MedicalBusiness',
    '@id': bizId,
    name: biz,
    url: base,
    ...(desc ? { description: desc } : {}),
    ...(phone ? { telephone: phone } : {}),
    ...(prior.address ? { address: prior.address } : {}),
    ...(areaServed.length ? { areaServed } : {}),
    ...(prior.priceRange ? { priceRange: prior.priceRange } : {}),
    ...(prior.hasMap ? { hasMap: prior.hasMap } : {}),
    ...(prior.image ? { image: prior.image } : img ? { image: img } : {}),
    ...(sameAs.length ? { sameAs } : {}),
    ...(Array.isArray(hours) && hours.length ? { openingHoursSpecification: hours } : {}),
  };

  return {
    '@context': 'https://schema.org',
    '@graph': [
      bizNode,
      { '@type': 'WebSite', '@id': siteId, url: base, name: biz, publisher: { '@id': bizId } },
      { '@type': 'WebPage', '@id': `${pageUrl}#webpage`, url: pageUrl,
        ...(title ? { name: title } : {}), ...(desc ? { description: desc } : {}),
        isPartOf: { '@id': siteId }, about: { '@id': bizId },
        ...(updatedAt ? { dateModified: new Date(updatedAt.replace(' ', 'T') + 'Z').toISOString() } : {}) },
    ],
  };
}

app.post('/api/clients/:id/aeo-fix', async (c) => {
  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'client not found' }, 404);
  const slug = await slugForClient(db, id);
  if (!slug) return c.json({ error: 'no built site for this client yet' }, 400);
  let domain = ''; try { domain = new URL(client.live_url).hostname.replace(/^www\./, ''); } catch {}
  if (!domain) return c.json({ error: 'this client has no live domain yet — the entity has to point at a real address' }, 400);

  let profiles = {}; try { profiles = JSON.parse(client.profiles || '{}'); } catch {}
  let hours = []; try { hours = JSON.parse(client.hours || '[]'); } catch {}

  const rows = (await db.prepare(`SELECT path, content, updated_at FROM site_files WHERE slug = ? AND path LIKE '%.html'`).bind(slug).all()).results || [];
  let done = 0, skipped = 0;
  for (const r of rows) {
    const html = String(r.content || '');
    if (!/<\/head>/i.test(html)) { skipped++; continue; }
    const graph = buildEntityGraph(client, domain, profiles, hours, String(r.path), html, String(r.updated_at || ''));
    const tag = `<script type="application/ld+json" id="${CC_ENTITY_TAG}">${JSON.stringify(graph)}</script>`;
    const existing = new RegExp(`<script[^>]+id=["']${CC_ENTITY_TAG}["'][^>]*>[\\s\\S]*?<\\/script>\\s*`, 'i');
    const next = existing.test(html) ? html.replace(existing, tag) : html.replace(/<\/head>/i, `${tag}</head>`);
    if (next === html) { skipped++; continue; }
    await db.prepare(`UPDATE site_files SET content = ?, updated_at = datetime('now') WHERE slug = ? AND path = ?`)
      .bind(next, slug, r.path).run();
    done++;
  }
  // Two addresses serving the same page split the credit. Point the twin that
  // nothing links to at the one that does — a canonical, not a deletion, so
  // nothing 404s and any existing link still works.
  let canonicals = 0;
  const byTitle = new Map();
  for (const r of rows) {
    const t = ((String(r.content).match(/<title>([^<]*)<\/title>/i) || [])[1] || '').trim().toLowerCase();
    if (!t || /^404/i.test(String(r.path))) continue;
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(String(r.path));
  }
  const allHtml2 = rows.map((r) => String(r.content || '')).join('\n');
  const inbound2 = {};
  for (const m of allHtml2.matchAll(/href=["']([^"'#?]+\.html)["']/gi)) {
    const f = m[1].split('/').pop(); inbound2[f] = (inbound2[f] || 0) + 1;
  }
  for (const paths of byTitle.values()) {
    if (paths.length < 2) continue;
    const winner = paths.slice().sort((a, b) => (inbound2[b] || 0) - (inbound2[a] || 0) || a.localeCompare(b))[0];
    const target = `https://${domain}/${winner === 'index.html' ? '' : winner}`;
    for (const p of paths) {
      if (p === winner) continue;
      const row = await db.prepare('SELECT content FROM site_files WHERE slug = ? AND path = ?').bind(slug, p).first();
      if (!row) continue;
      const html2 = String(row.content);
      const link = `<link rel="canonical" href="${target}">`;
      const has = /<link[^>]+rel=["']canonical["'][^>]*>/i;
      const out = has.test(html2) ? html2.replace(has, link) : html2.replace(/<\/head>/i, `${link}</head>`);
      if (out === html2) continue;
      await db.prepare(`UPDATE site_files SET content = ?, updated_at = datetime('now') WHERE slug = ? AND path = ?`).bind(out, slug, p).run();
      canonicals++;
    }
  }
  const sameAsCount = Object.values(profiles).filter((v) => /^https?:\/\//i.test(String(v || ''))).length;
  await logEvent(db, id, 'aeo_fix', `🤖 Entity graph written to ${done} page(s) — ${sameAsCount} off-site profile(s) linked${hours.length ? ', opening hours published' : ''}${canonicals ? `, ${canonicals} duplicate page(s) pointed at the real address` : ''}`);
  return c.json({ ok: true, pages: done, skipped, same_as: sameAsCount, hours: hours.length, canonicals,
    note: 'Live on the served copy now. Publish the site to put it in the repo permanently.' });
});

// Rebuild sitemap.xml from the pages that actually exist. The old one was
// hand-maintained, so it drifted: the blog engine published a post nobody
// listed, six service landing pages were never added, and two legal pages
// existed at two URLs each. Generated from the served files, it cannot drift.
app.post('/api/clients/:id/sitemap-rebuild', async (c) => {
  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'client not found' }, 404);
  const slug = await slugForClient(db, id);
  if (!slug) return c.json({ error: 'no built site for this client yet' }, 400);
  let domain = ''; try { domain = new URL(client.live_url).hostname.replace(/^www\./, ''); } catch {}
  if (!domain) return c.json({ error: 'no live domain yet — a sitemap has to point at the real address' }, 400);

  const rows = (await db.prepare(`SELECT path, content, updated_at FROM site_files WHERE slug = ? AND path LIKE '%.html'`).bind(slug).all()).results || [];
  const SKIP = /^(404|thanks?|thank-you)\b/i;
  // When a page exists at two addresses, keep the one the SITE ITSELF links to.
  // Sorting alphabetically picked legal-terms.html over terms.html on Anywhere —
  // and terms.html was the one in all 42 footers. The sitemap would have pointed
  // at the address nothing links to, which is the wrong half of the pair.
  const allHtml = rows.map((r) => String(r.content || '')).join('\n');
  const inbound = {};
  for (const m of allHtml.matchAll(/href=["']([^"'#?]+\.html)["']/gi)) {
    const f = m[1].split('/').pop(); inbound[f] = (inbound[f] || 0) + 1;
  }
  const rank = (p) => -(inbound[p] || 0);
  const seenTitle = new Set(), pages = [], dropped = [];
  for (const r of rows.slice().sort((a, b) => rank(String(a.path)) - rank(String(b.path)) || String(a.path).localeCompare(String(b.path)))) {
    const p = String(r.path);
    if (SKIP.test(p)) { dropped.push(`${p} (not a content page)`); continue; }
    const t = ((String(r.content).match(/<title>([^<]*)<\/title>/i) || [])[1] || '').trim().toLowerCase();
    if (t && seenTitle.has(t)) { dropped.push(`${p} (duplicate of an existing page)`); continue; }
    if (t) seenTitle.add(t);
    pages.push({ path: p, at: String(r.updated_at || '').slice(0, 10) });
  }
  const before = rows.length;
  const loc = (p) => `https://${domain}/${p === 'index.html' ? '' : p}`;
  // selection order was by inbound links; the file itself reads better in page order
  pages.sort((a, b) => (a.path === 'index.html' ? -1 : b.path === 'index.html' ? 1 : a.path.localeCompare(b.path)));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + pages.map((p) => `  <url><loc>${loc(p.path)}</loc>${p.at ? `<lastmod>${p.at}</lastmod>` : ''}</url>`).join('\n')
    + `\n</urlset>\n`;
  await db.prepare(
    `INSERT INTO site_files (slug, path, content, content_type, is_base64, updated_at)
     VALUES (?, 'sitemap.xml', ?, 'application/xml; charset=utf-8', 0, datetime('now'))
     ON CONFLICT(slug, path) DO UPDATE SET content=excluded.content, content_type=excluded.content_type, updated_at=datetime('now')`
  ).bind(slug, xml).run();
  await logEvent(db, id, 'sitemap_rebuilt', `🗺 Sitemap rebuilt for ${domain} — ${pages.length} pages listed${dropped.length ? `, ${dropped.length} excluded` : ''}`);
  return c.json({ ok: true, listed: pages.length, scanned: before, dropped, url: `https://${domain}/sitemap.xml`,
    note: 'Live on the served copy now. Publish the site to put it in the repo permanently.' });
});

// Profiles + hours — the inputs the entity graph is built from.
app.post('/api/clients/:id/aeo-profile', async (c) => {
  const id = Number(c.req.param('id'));
  let f = {}; try { f = await c.req.json(); } catch {}
  const clean = {};
  for (const [k, v] of Object.entries(f.profiles || {})) {
    const url = String(v || '').trim();
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) return c.json({ error: `${k} must be a full web address starting with https://` }, 400);
    clean[k.slice(0, 24)] = url.slice(0, 300);
  }
  const hours = Array.isArray(f.hours) ? f.hours.slice(0, 7) : [];
  await c.env.DB.prepare('UPDATE clients SET profiles = ?, hours = ? WHERE id = ?')
    .bind(JSON.stringify(clean), JSON.stringify(hours), id).run();
  return c.json({ ok: true, profiles: clean, hours: hours.length });
});

// One-click llms.txt: a plain-language brief written FOR models. Not marketing
// copy — models discard adjectives. Facts, services, area, hours, how to book.
app.post('/api/clients/:id/llms-txt', async (c) => {
  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'client not found' }, 404);
  const slug = await slugForClient(db, id);
  if (!slug) return c.json({ error: 'no built site for this client yet' }, 400);
  let domain = ''; try { domain = new URL(client.live_url).hostname.replace(/^www\./, ''); } catch {}
  const biz = client.business_name || client.name || '';  // llms.txt still needs a label

  const rows = (await db.prepare(`SELECT path, content FROM site_files WHERE slug = ? AND path LIKE '%.html'`).bind(slug).all()).results || [];
  const titleOf = (h) => ((h.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').replace(/\s*[|·—-]\s*[^|·—-]*$/, '').trim();
  const descOf = (h) => ((h.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i) || [])[1] || '').trim();
  // Decode the handful of entities that show up in <title>/description — an
  // answer engine quoting "IV Menu &amp; Prices" back at a customer looks broken.
  const NAMED = { amp: '&', apos: "'", quot: '"', nbsp: ' ', mdash: '—', ndash: '–', lt: '<', gt: '>', hellip: '…', rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d' };
  const dec = (t) => String(t)
    // numeric entities, decimal AND hex — &#x27; slipped through a named-only list
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in NAMED ? NAMED[n.toLowerCase()] : m));
  // Exclude by PATH, not by title — the 404 page is titled "Page Not Found" and
  // was being advertised to answer engines as a service.
  const SKIP = /^(404|privacy|legal-terms|review-us|thanks?|thank-you)\b/i;
  const pages = rows.map((r) => ({ path: r.path, title: dec(titleOf(r.content)), desc: dec(descOf(r.content)) }))
    .filter((p) => p.title && !SKIP.test(p.path));
  const idx = rows.find((r) => r.path === 'index.html');
  const tagline = idx ? descOf(idx.content) : '';
  const phone = (rows.map((r) => (r.content.match(/tel:\+?1?(\d{10})/i) || [])[1]).find(Boolean) || '');
  const fmtPhone = phone ? `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}` : '';

  // Sections must be mutually exclusive — city pages were appearing under both
  // "Services" and "Areas served", which reads as a site padding its own list.
  const loc = pages.filter((p) => /^(iv-therapy-|city-)/i.test(p.path));
  const locSet = new Set(loc.map((p) => p.path));
  const svc = pages.filter((p) => !locSet.has(p.path)
    && !/^(index|about|faq|blog|safety|locations|membership)/i.test(p.path) && !/^blog-/i.test(p.path));
  const L = [];
  L.push(`# ${biz}`, '');
  if (tagline) L.push(`> ${tagline}`, '');
  L.push(`${biz}${domain ? ` (${domain})` : ''} is a real, currently-operating business.${fmtPhone ? ` Bookings and questions: ${fmtPhone}.` : ''}`, '');
  if (svc.length) {
    L.push('## Services', '');
    for (const p of svc.slice(0, 40)) L.push(`- [${p.title}](https://${domain}/${p.path})${p.desc ? `: ${p.desc}` : ''}`);
    L.push('');
  }
  if (loc.length) {
    L.push('## Areas served', '');
    for (const p of loc) L.push(`- [${p.title}](https://${domain}/${p.path})`);
    L.push('');
  }
  const info = pages.filter((p) => /^(about|faq|safety|membership|locations)/i.test(p.path));
  if (info.length) {
    L.push('## About and policies', '');
    for (const p of info) L.push(`- [${p.title}](https://${domain}/${p.path})${p.desc ? `: ${p.desc}` : ''}`);
    L.push('');
  }
  const blogs = pages.filter((p) => /^blog-/i.test(p.path));
  if (blogs.length) {
    L.push('## Articles', '');
    for (const p of blogs.slice(0, 30)) L.push(`- [${p.title}](https://${domain}/${p.path})`);
    L.push('');
  }
  L.push('## Notes for answer engines', '');
  L.push(`- Business name: ${biz}`);
  if (fmtPhone) L.push(`- Phone: ${fmtPhone}`);
  if (domain) L.push(`- Website: https://${domain}`);
  L.push('- All prices, services and availability on the linked pages are authoritative.');
  L.push('- This file is generated from the live site and updated when the site changes.');
  L.push('');
  const body = L.join('\n');

  await db.prepare(
    `INSERT INTO site_files (slug, path, content, content_type, is_base64, updated_at)
     VALUES (?, 'llms.txt', ?, 'text/plain; charset=utf-8', 0, datetime('now'))
     ON CONFLICT(slug, path) DO UPDATE SET content=excluded.content, content_type=excluded.content_type, updated_at=datetime('now')`
  ).bind(slug, body).run();
  await logEvent(db, id, 'aeo_llms', `🤖 llms.txt published for ${biz} — ${pages.length} pages described for answer engines`);
  return c.json({ ok: true, bytes: body.length, pages: pages.length, url: domain ? `https://${domain}/llms.txt` : '', preview: body.slice(0, 1200) });
});

// Cross-client AEO roll-up — the view Tiffany demos from.
app.get('/api/aeo-overview', async (c) => {
  const db = c.env.DB;
  const days = Math.min(365, Math.max(7, Number(c.req.query('days') || 28)));
  const clients = (await db.prepare(`SELECT * FROM clients WHERE stage != 'archived' AND (live_url != '' OR preview_url != '')`).all()).results || [];
  const out = [];
  for (const cl of clients) {
    const slug = await slugForClient(db, cl.id);
    if (!slug) continue;
    const rows = (await db.prepare(
      `SELECT kind, SUM(n) AS n FROM ai_visits WHERE slug = ? AND day > date('now', ?) GROUP BY kind`
    ).bind(slug, `-${days} days`).all()).results || [];
    const t = { answer: 0, referral: 0, train: 0 };
    for (const r of rows) if (t[r.kind] !== undefined) t[r.kind] = Number(r.n);
    const fileRows = (await db.prepare(
      `SELECT path, content FROM site_files WHERE slug = ? AND (path LIKE '%.html' OR path IN ('llms.txt','sitemap.xml'))`
    ).bind(slug).all()).results || [];
    const a = aeoAudit(fileRows, cl.business_name || '');
    let domain = ''; try { domain = new URL(cl.live_url).hostname.replace(/^www\./, ''); } catch {}
    out.push({ id: cl.id, name: cl.business_name || cl.name || cl.email, domain, slug, traffic: t, content_score: a.score, content_max: a.max, top_fix: a.fixes[0] || null });
  }
  out.sort((x, y) => (y.traffic.referral - x.traffic.referral) || (x.content_score - y.content_score));
  return c.json({ ok: true, days, clients: out });
});

app.post('/api/clients/:id/golive-domain', async (c) => {
  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'client not found' }, 404);
  let f = {}; try { f = await c.req.json(); } catch {}
  const domain = String(f.domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (!domain || !domain.includes('.')) return c.json({ error: 'domain required (e.g. herbusiness.com)' }, 400);
  if (!c.env.CLOUDFLARE_API_TOKEN || !c.env.CF_ACCOUNT_ID) return c.json({ error: 'Cloudflare token/account not configured' }, 400);
  const slug = await slugForClient(db, id);
  if (!slug) return c.json({ error: 'no built site for this client yet' }, 400);
  const cf = async (path, method, body) => {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method: method || 'GET',
      headers: { Authorization: `Bearer ${c.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    return res.json().catch(() => ({}));
  };
  const steps = [];
  // 1. the zone must already be in the Cloudflare account (nameservers moved)
  const zones = await cf(`/zones?name=${domain}`);
  const zone = zones && zones.result && zones.result[0];
  if (!zone) {
    return c.json({ ok: false, steps, error: `${domain} is not in the Cloudflare account yet (or the API token cannot list zones). One-time setup: add the domain as a zone in Cloudflare + point its nameservers there, and give the token Zone:Read + Workers Custom Domains:Edit + Email Routing:Edit.` });
  }
  steps.push(`zone found (status: ${zone.status})`);

  // 2. attach apex + www to this worker (creates DNS records + SSL automatically)
  //
  // THE CONFLICT (Cloudflare error 100117): a Workers custom domain cannot be
  // attached to a hostname that still has its own A/AAAA/CNAME record. During a
  // migration those records are exactly what we WANT present up to this moment —
  // they keep the old site serving with zero downtime while nameservers move.
  // So the launch has to clear them itself, right here, at the last possible
  // second. Doing it by hand cost an hour on the anywhereinfusions.com launch.
  //
  // Only address records for the two hostnames being launched are removed.
  // TXT (SPF/DMARC/DKIM), MX and everything else are never touched — deleting an
  // email record during a website launch would be a silent, serious failure.
  const clearConflicts = async (host) => {
    const cleared = [];
    for (const type of ['A', 'AAAA', 'CNAME']) {
      const list = await cf(`/zones/${zone.id}/dns_records?type=${type}&name=${encodeURIComponent(host)}`);
      for (const rec of (list && list.result) || []) {
        const del = await cf(`/zones/${zone.id}/dns_records/${rec.id}`, 'DELETE');
        if (del && del.success) cleared.push(`${type} ${host} -> ${String(rec.content).slice(0, 40)}`);
      }
    }
    return cleared;
  };

  const attach = async (host) => cf(`/accounts/${c.env.CF_ACCOUNT_ID}/workers/domains`, 'PUT', {
    environment: 'production', hostname: host, service: 'conversionco-mission-control', zone_id: zone.id });

  for (const host of [domain, `www.${domain}`]) {
    let att = await attach(host);
    if (!att.success) {
      const why = JSON.stringify(att.errors || []);
      // 100117 = "already has externally managed DNS records". Clear and retry once.
      if (/100117|externally managed DNS/i.test(why)) {
        const cleared = await clearConflicts(host);
        if (cleared.length) {
          steps.push(`${host}: cleared the old record(s) blocking handover — ${cleared.join(', ')}`);
          att = await attach(host);
        }
      }
    }
    steps.push(`${host}: ${att.success ? 'attached ✓' : 'FAILED — ' + JSON.stringify(att.errors || att.messages || []).slice(0, 200)}`);
    if (!att.success && host === domain) {
      return c.json({ ok: false, steps, error: 'Could not attach the domain. If this says the token lacks permission, it needs Workers Custom Domains edit; any other message is the real reason.' });
    }
  }
  // 3. map the hostnames to the site so the worker serves it
  await setSetting(db, `livehost_${domain}`, slug);
  await setSetting(db, `livehost_www.${domain}`, slug);
  steps.push('direct serving mapped');
  // 4. optional branded inbox: hello@domain forwards to the client's email
  if (f.emailForward && client.email) {
    const er = await cf(`/zones/${zone.id}/email/routing/rules`, 'POST', {
      enabled: true, name: 'hello forward',
      matchers: [{ type: 'literal', field: 'to', value: `hello@${domain}` }],
      actions: [{ type: 'forward', value: [client.email] }] });
    steps.push(`hello@${domain}: ${er && er.success ? `forwards to ${client.email} ✓` : 'not set (enable Email Routing on the zone once, then re-run)'}`);
  }
  // 5. flip the card live + instant GSC enrollment (quiet — no launch email here)
  //
  // Everything above this point IS the launch. From here down is bookkeeping, and
  // bookkeeping must never be able to report a successful launch as a failure —
  // on 8/20 a bad column name in this exact call threw a 500 on a site that was
  // already serving perfectly.
  try {
    await touchClient(db, id, { live_url: `https://${domain}`, stage: 'live', launched_at: new Date().toISOString() });
    steps.push('client card flipped to live ✓');
  } catch (e) {
    steps.push(`card update failed (site IS live) — ${String(e && e.message || e).slice(0, 120)}`);
  }
  try {
    await logEvent(db, id, 'launched', `🌐 ${domain} attached to direct hosting — DNS, SSL, serving, and Google enrollment all automatic`);
  } catch { /* never block a launch on a log line */ }
  c.executionCtx.waitUntil((async () => {
    try { const s2 = await getSettings(db); await gscEnsureClient(c.env, s2, { ...client, live_url: `https://${domain}`, stage: 'live' }); } catch {}
  })());
  return c.json({ ok: true, steps, url: `https://${domain}` });
});

// ⏪ Panic button: restore the client's site to its previous version (new commit,
// never a force-push) — auto-publish then reimports it within 5 minutes.
app.post('/api/clients/:id/rollback', async (c) => {
  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  if (!c.env.GITHUB_TOKEN) return c.json({ error: 'GitHub not configured' }, 500);
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'client not found' }, 404);
  // resolve slug from imported metas
  const metas = (await db.prepare(`SELECT slug, content FROM site_files WHERE path='site-meta.json'`).all()).results || [];
  let slug = null;
  for (const m of metas) { try { if (JSON.parse(m.content).client_id === id) { slug = m.slug; break; } } catch {} }
  if (!slug) return c.json({ error: 'no site found for this client yet' }, 400);
  const settings = await getSettings(db);
  const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
  const gh = ghFetcher(c.env);
  const ghPost = async (path, method, body) => {
    const res = await fetch(`https://api.github.com${path}`, {
      method, headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${data.message || ''}`);
    return data;
  };
  try {
    const commits = await gh(`/repos/${repo}/commits?path=sites/${slug}&per_page=3&sha=main`);
    if (!Array.isArray(commits) || commits.length < 2) return c.json({ error: 'No earlier version exists yet for this site' }, 400);
    const prev = commits[1]; // the version before the latest change
    const prevCommit = await gh(`/repos/${repo}/git/commits/${prev.sha}`);
    const prevTree = await gh(`/repos/${repo}/git/trees/${prevCommit.tree.sha}?recursive=0`);
    const sitesEntry = (prevTree.tree || []).find((t) => t.path === 'sites');
    const prevSites = await gh(`/repos/${repo}/git/trees/${sitesEntry.sha}`);
    const slugEntry = (prevSites.tree || []).find((t) => t.path === slug && t.type === 'tree');
    if (!slugEntry) return c.json({ error: 'Previous version not found in history' }, 400);
    const headRef = await gh(`/repos/${repo}/git/ref/heads/main`);
    const headCommit = await gh(`/repos/${repo}/git/commits/${headRef.object.sha}`);
    const newTree = await ghPost(`/repos/${repo}/git/trees`, 'POST', {
      base_tree: headCommit.tree.sha,
      tree: [{ path: `sites/${slug}`, mode: '040000', type: 'tree', sha: slugEntry.sha }],
    });
    const newCommit = await ghPost(`/repos/${repo}/git/commits`, 'POST', {
      message: `⏪ Rollback sites/${slug} to ${prev.sha.slice(0, 7)} (panic button from Mission Control)`,
      tree: newTree.sha, parents: [headRef.object.sha],
    });
    await ghPost(`/repos/${repo}/git/refs/heads/main`, 'PATCH', { sha: newCommit.sha, force: false });
    await logEvent(db, id, 'site_rolled_back', `⏪ Site restored to the previous version (${prev.sha.slice(0, 7)}: "${(prev.commit?.message || '').split('\n')[0].slice(0, 70)}") — republishing within 5 min`);
    return c.json({ ok: true, restored: prev.sha.slice(0, 7), was: (prev.commit?.message || '').split('\n')[0].slice(0, 90) });
  } catch (e) { return c.json({ error: 'Rollback failed: ' + String(e.message).slice(0, 200) }, 502); }
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

// 📤 APPROVE PREVIEW — Tiffany's send button. Until this is called, the client
// knows nothing: no reveal email, no final invoice, portal still shows "building".
app.post('/api/clients/:id/approve-preview', async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ ok: false, error: 'not found' }, 404);
  if (!client.preview_url) return c.json({ ok: false, error: 'no preview to send yet' }, 400);
  const settings = await getSettings(db);
  const b = getBilling(client);
  if (b.preview_approved) return c.json({ ok: true, already: true });
  b.preview_approved = new Date().toISOString();
  await touchClient(db, id, { billing: JSON.stringify(b) });
  await logEvent(db, id, 'preview_approved', '📤 Tiffany approved the preview — sending it to the client now');
  // 1) final balance invoice (was auto at publish; now rides on her approval)
  let invoiceSent = false;
  try {
    if (c.env.STRIPE_SECRET_KEY && b.dep_status === 'paid' && !b.fin_id && !b.fin_status && b.invoice_status !== 'paid') {
      const tierKey = b.invoice_tier || (client.tier === 'premium' ? 'premium' : 'standard');
      const custId = b.customer_id || (await ensureCustomer(c.env.STRIPE_SECRET_KEY, client.email, client.name || client.business_name || '')).id;
      const inv = await sendInvoice(c.env.STRIPE_SECRET_KEY, custId, tierKey, client.business_name || '', 'final');
      b.customer_id = custId; b.fin_id = inv.id; b.fin_status = inv.status; b.fin_url = inv.url;
      await touchClient(db, id, { billing: JSON.stringify(b) });
      await logEvent(db, id, 'invoice_sent', `Preview approved — final balance invoice sent (${halfDisplay(tierKey)}) 💳`);
      invoiceSent = true;
    }
  } catch (e) { await logEvent(db, id, 'error', `Final invoice send failed: ${e.message}`); }
  // 2) the reveal email — their first look at their own website
  const first = (client.name || '').split(' ')[0] || 'there';
  const biz = client.business_name || client.name || 'your business';
  const purl = `${BASE_URL}/portal/${id}/${await portalToken(c.env, 'portal', id)}`;
  const emailed = await emailClient(c.env, db, client, settings,
    `${biz} — your new website is ready to see 👀`,
    `<p>Hi ${first},</p>
     <p>It's here. Your new website for <b>${biz}</b> is built and waiting for you:</p>
     <p style="font-size:16px;"><a href="${client.preview_url}"><b>${client.preview_url}</b></a></p>
     <p>Click through every page — on your phone too, since that's where most of your clients will see it. If anything isn't exactly how you want it (a price, a photo, a word), just reply to this email and we'll change it. Revisions at this stage are included.</p>
     <p>Your client portal has the full picture any time: <a href="${purl}">${purl}</a></p>
     <p>Talk soon,<br>The ConversionCo Team</p>`,
    'preview_sent', `📤 Preview reveal email sent to ${client.email}`);
  return c.json({ ok: true, emailed, invoiceSent });
});

// 🔥 FIRE ANYWAY — Tiffany's manual override. Writes a fire-request flag into the
// sites repo; Claude's standing watch sees the commit within ~a minute and kicks
// the builder immediately instead of waiting for the next hourly alarm.
// Shared fire-cord: commit a fire-request flag to the mission-control repo's
// fire-signal branch (NOT main — no deploys). Claude's standing watch sees the
// branch move within ~a minute and kicks/does the build. Used by the dashboard
// button AND by queueWatch's automatic stall recovery.
async function fireSignal(env, db, by) {
  if (!env.GITHUB_TOKEN) return { ok: false, error: 'GITHUB_TOKEN secret not set' };
  const rows = (await db.prepare(`SELECT id, business_name, name, stage FROM clients WHERE stage IN ('intake2_done','generating')`).all()).results || [];
  const payload = { requested_at: new Date().toISOString(), by,
    waiting: rows.map((r) => ({ id: r.id, biz: r.business_name || r.name, stage: r.stage })) };
  const ghHeaders = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' };
  const api = `https://api.github.com/repos/conversionco918/conversionco-client-sites/contents/fire-requests/latest.json`;
  const getRes = await fetch(api + '?ref=main', { headers: ghHeaders });
  const existing = getRes.ok ? await getRes.json() : null;
  const bytes = new TextEncoder().encode(JSON.stringify(payload, null, 2));
  let bin = ''; for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  const putRes = await fetch(api, { method: 'PUT', headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `🔥 FIRE BUILDER — ${by} (${payload.waiting.length} waiting)`,
      branch: 'main', content: btoa(bin), ...(existing && existing.sha ? { sha: existing.sha } : {}) }) });
  if (!putRes.ok) { const out = await putRes.json().catch(() => ({}));
    return { ok: false, error: ('flag commit failed: ' + JSON.stringify(out)).slice(0, 200) }; }
  return { ok: true, waiting: payload.waiting.length };
}

app.post('/api/fire-builder', async (c) => {
  const db = c.env.DB;
  const r = await fireSignal(c.env, db, 'dashboard fire button');
  if (!r.ok) return c.json(r);
  await logEvent(db, null, 'fire_requested', `🔥 Manual builder fire requested from the dashboard (${r.waiting} client(s) waiting)`);
  return c.json(r);
});

// 🛠 BUILDER HEARTBEAT — "is the machine coming for my queued builds?"
// The auto-builder scheduled task fires EVERY HOUR at :23 UTC.
app.get('/api/builder-status', async (c) => {
  const db = c.env.DB;
  const now = new Date();
  let next = null;
  for (let add = 0; add <= 2 && !next; add++) {
    const cand = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + add, 23, 0));
    if (cand > now) next = cand;
  }
  const lastOf = async (t) => (await db.prepare('SELECT created_at FROM events WHERE type = ? ORDER BY id DESC LIMIT 1').bind(t).first())?.created_at || null;
  const waiting = [];
  const rows = (await db.prepare(`SELECT * FROM clients WHERE stage IN ('intake2_done','generating')`).all()).results || [];
  for (const cl of rows) {
    let b = {}; try { b = JSON.parse(cl.billing || '{}'); } catch {}
    const readyAt = Date.parse(String(cl.updated_at || '').replace(' ', 'T') + 'Z') || Date.now();
    const waitingMins = Math.max(0, Math.round((Date.now() - readyAt) / 60000));
    waiting.push({ id: cl.id, biz: cl.business_name || cl.name || cl.email, stage: cl.stage,
      paid: depositPaid(b), waitingMins, overdue: cl.stage === 'intake2_done' && depositPaid(b) && waitingMins > 45 });
  }
  return c.json({
    nextRunAt: next ? next.toISOString() : null,
    minutesUntil: next ? Math.round((next - now) / 60000) : null,
    lastBuildStartedAt: await lastOf('build_started'),
    lastPublishedAt: await lastOf('auto_published'),
    waiting,
  });
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
// 📧 THE EMAIL LIST — Mission Control owns it, the ESP is optional.
// Every website signup is already a row in `leads`. That is the list of
// record: it needs no third-party account, it works from day one of a build,
// and it survives a client switching email platforms. The client's own ESP
// (Kit, Mailchimp, GoHighLevel, whatever) is a fan-out fired from the
// visitor's browser, never the source of truth. These two routes make that
// ownership real — she can see and export the list without logging into
// anyone else's product.
//
// Deduped by lowercased email, keeping the FIRST time we saw the address
// (that is the true join date) and the most recent non-empty name.
async function emailListFor(db, id) {
  const rows = (await db.prepare(
    `SELECT email, name, source, slug, created_at FROM leads
      WHERE client_id = ? AND email IS NOT NULL AND TRIM(email) != ''
      ORDER BY id ASC`).bind(id).all()).results || [];
  const seen = new Map();
  for (const r of rows) {
    const key = String(r.email || '').trim().toLowerCase();
    if (!key || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) continue;
    const prev = seen.get(key);
    if (!prev) seen.set(key, { email: key, name: String(r.name || '').trim(), source: r.source || '', slug: r.slug || '', joined: r.created_at, times: 1 });
    else { prev.times += 1; if (!prev.name && r.name) prev.name = String(r.name).trim(); }
  }
  return [...seen.values()].reverse(); // newest first for the UI
}

// ══════════════════════════════════════════════════════════════════════════
// 🎯 CLOSED-LOOP ADS (8/20) — the point of all of this
// ------------------------------------------------------------------------
// Google's bidding is only as smart as the feedback it gets. Out of the box it
// learns "a form was submitted". It has no idea whether that person booked, or
// what they were worth. So it happily buys more of whatever produces cheap
// form fills. These routes close the loop: mark which leads actually became
// customers, hand that back to Google, and measure the account on bookings and
// revenue instead of on clicks.
// ══════════════════════════════════════════════════════════════════════════

// Mark a lead booked / not booked, with what the visit was worth.
// This one button is what turns cost-per-lead into cost-per-customer.
// ── SEARCH TERMS → NEGATIVE KEYWORDS ──────────────────────────────────────
// The negative library is guesswork made in advance. The real waste is in what
// people ACTUALLY typed, and it is different in every account. This is the
// highest-value recurring hour in any Google Ads account, so it should take
// thirty seconds instead: paste the search-terms export, get back the junk
// ranked by money burned, and a negative list ready to import.
//
// Google's export has a preamble row, then a header row, then data, and its
// column names shift between UI versions — so we sniff the header instead of
// assuming positions.
function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
function csvNum(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : 0;
}
function parseSearchTerms(csv) {
  const lines = String(csv || '').split(/\r?\n/).filter((l) => l.trim());
  let hdr = -1;
  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    const low = lines[i].toLowerCase();
    if (low.includes('search term') && (low.includes('cost') || low.includes('clicks') || low.includes('impr'))) { hdr = i; break; }
  }
  if (hdr === -1) return { error: 'Could not find a header row with "Search term" in that paste. Export from Google Ads with the Search terms report and paste the whole thing, header included.' };
  const cols = parseCsvLine(lines[hdr]).map((x) => x.trim().toLowerCase());
  const find = (...names) => { for (const n of names) { const i = cols.findIndex((c) => c === n || c.startsWith(n)); if (i > -1) return i; } return -1; };
  const iTerm = find('search term', 'search terms');
  const iCost = find('cost', 'spend');
  const iClicks = find('clicks');
  const iImpr = find('impr', 'impressions');
  const iConv = find('conversions', 'conv.');
  const iCamp = find('campaign');
  if (iTerm === -1) return { error: 'No "Search term" column found.' };
  const rows = [];
  for (let i = hdr + 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const term = String(cells[iTerm] || '').trim().toLowerCase();
    if (!term || /^total/i.test(term) || term === '--') continue;
    rows.push({
      term,
      cost: iCost > -1 ? csvNum(cells[iCost]) : 0,
      clicks: iClicks > -1 ? csvNum(cells[iClicks]) : 0,
      impr: iImpr > -1 ? csvNum(cells[iImpr]) : 0,
      conv: iConv > -1 ? csvNum(cells[iConv]) : 0,
      campaign: iCamp > -1 ? String(cells[iCamp] || '').slice(0, 60) : '',
    });
  }
  return { rows };
}
// Classify a term as waste, and say WHY in words she can act on. A reason she
// disagrees with is a reason she can override — an unexplained verdict is not.
function classifyTerm(t, facts) {
  const term = ' ' + t.term + ' ';
  for (const [cat, words] of Object.entries(NEG_LIB)) {
    for (const w of words) {
      if (term.includes(' ' + w + ' ') || t.term === w || t.term.startsWith(w + ' ') || t.term.endsWith(' ' + w)) {
        return { waste: true, why: `matches the ${cat.replace(/_/g, ' ')} exclusion list ("${w}")`, cat };
      }
    }
  }
  if (/\b(free|cheap|cheapest|discount|coupon|groupon)\b/.test(term)) return { waste: true, why: 'price-shopper language — rarely books at full ticket', cat: 'bargain' };
  if (/\b(near me)\b/.test(term) === false && /\b(what is|why does|how does|meaning|definition|side effects|dangers|reddit|wiki)\b/.test(term)) return { waste: true, why: 'research intent, not booking intent', cat: 'research' };
  // Spending real money with nothing to show is its own category, whatever the words say.
  if (t.conv === 0 && t.clicks >= 3 && t.cost >= (facts.cpl || 40)) {
    return { waste: true, why: `${t.clicks} clicks and $${t.cost.toFixed(2)} spent with zero conversions`, cat: 'no-return' };
  }
  return { waste: false };
}

// ── SPEND + PERFORMANCE INGEST ────────────────────────────────────────────
// Mission Control knew nothing about cost, clicks or CPC, so every question
// about how the account is doing meant opening Google Ads. Google Ads API
// write access is still pending, but she can export a report today — so accept
// the paste now and swap in the API later behind the same stored shape.
// Accepts either a campaign report or a day-by-day report; sniffs which.
function parseAdsReport(csv) {
  const lines = String(csv || '').split(/\r?\n/).filter((l) => l.trim());
  let hdr = -1;
  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    const low = lines[i].toLowerCase();
    if ((low.includes('cost') || low.includes('spend')) && (low.includes('campaign') || low.includes('day') || low.includes('date') || low.includes('clicks'))) { hdr = i; break; }
  }
  if (hdr === -1) return { error: 'Could not find a header row with a Cost column. Export from Google Ads (Campaigns or a day report) and paste the whole thing including headers.' };
  const cols = parseCsvLine(lines[hdr]).map((x) => x.trim().toLowerCase());
  const find = (...names) => { for (const n of names) { const i = cols.findIndex((c) => c === n || c.startsWith(n)); if (i > -1) return i; } return -1; };
  const iDay = find('day', 'date');
  const iCamp = find('campaign');
  const iCost = find('cost', 'spend');
  const iClicks = find('clicks');
  const iImpr = find('impr', 'impressions');
  const iConv = find('conversions', 'conv.');
  const rows = [];
  for (let i = hdr + 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const label = String(cells[iCamp > -1 ? iCamp : (iDay > -1 ? iDay : 0)] || '').trim();
    if (!label || /^total/i.test(label)) continue;
    rows.push({
      day: iDay > -1 ? String(cells[iDay] || '').trim().slice(0, 10) : '',
      campaign: iCamp > -1 ? String(cells[iCamp] || '').trim().slice(0, 80) : '',
      cost: iCost > -1 ? csvNum(cells[iCost]) : 0,
      clicks: iClicks > -1 ? csvNum(cells[iClicks]) : 0,
      impr: iImpr > -1 ? csvNum(cells[iImpr]) : 0,
      conv: iConv > -1 ? csvNum(cells[iConv]) : 0,
    });
  }
  return { rows, byDay: iDay > -1 };
}

app.post('/api/clients/:id/ads-performance', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const parsed = parseAdsReport(body.csv || '');
  if (parsed.error) return c.json({ ok: false, error: parsed.error }, 400);
  const rows = parsed.rows;
  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const cost = sum('cost'), clicks = sum('clicks'), impr = sum('impr'), conv = sum('conv');
  const days = [...new Set(rows.map((r) => r.day).filter(Boolean))].sort();
  const snap = {
    at: new Date().toISOString(),
    rows: rows.length,
    cost: Math.round(cost * 100) / 100,
    clicks, impressions: impr, conversions: conv,
    cpc: clicks ? Math.round((cost / clicks) * 100) / 100 : 0,
    ctr: impr ? Math.round((clicks / impr) * 10000) / 100 : 0,
    cpa: conv ? Math.round((cost / conv) * 100) / 100 : 0,
    first_day: days[0] || '', last_day: days[days.length - 1] || '', day_count: days.length,
    by_day: parsed.byDay ? days.map((d) => {
      const rs = rows.filter((r) => r.day === d);
      return { day: d, cost: Math.round(rs.reduce((a, r) => a + r.cost, 0) * 100) / 100, clicks: rs.reduce((a, r) => a + r.clicks, 0), conv: rs.reduce((a, r) => a + r.conv, 0) };
    }) : [],
    by_campaign: [...new Set(rows.map((r) => r.campaign).filter(Boolean))].map((cn) => {
      const rs = rows.filter((r) => r.campaign === cn);
      return { campaign: cn, cost: Math.round(rs.reduce((a, r) => a + r.cost, 0) * 100) / 100, clicks: rs.reduce((a, r) => a + r.clicks, 0), conv: rs.reduce((a, r) => a + r.conv, 0) };
    }).sort((a, b) => b.cost - a.cost).slice(0, 20),
  };
  await setSetting(c.env.DB, 'ads_perf_' + id, JSON.stringify(snap).slice(0, 90000));
  await logEvent(c.env.DB, id, 'ads_performance',
    `\u{1F4CA} Ads performance updated: $${snap.cost} spend, ${snap.clicks} clicks, $${snap.cpc} CPC${snap.day_count ? ` over ${snap.day_count} days` : ''}`);
  return c.json({ ok: true, ...snap });
});

// ── THE ROI VIEW — the number that renews the retainer ────────────────────
// Spend comes from the pasted report; leads, calls, bookings and revenue come
// from our own database. Every figure says where it came from, and anything we
// genuinely cannot know says so instead of showing a confident zero.
async function adsRoi(env, id) {
  const settings = await getSettings(env.DB);
  let perf = {}, econ = {}, terms = {};
  try { perf = JSON.parse(settings['ads_perf_' + id] || '{}'); } catch {}
  try { econ = JSON.parse(settings['ads_econ_' + id] || '{}'); } catch {}
  try { terms = JSON.parse(settings['ads_terms_' + id] || '{}'); } catch {}
  const rows = (await env.DB.prepare(
    `SELECT * FROM leads WHERE client_id = ? AND created_at >= datetime('now','-30 day')`).bind(id).all()).results || [];
  const paid = rows.filter((r) => r.gclid || r.wbraid || r.gbraid || /google-ads|cpc|paid/i.test(r.source || ''));
  const booked = rows.filter((r) => r.status === 'booked');
  const bookedPaid = paid.filter((r) => r.status === 'booked');
  const revenue = booked.reduce((a, r) => a + (Number(r.value) || 0), 0);
  const revenuePaid = bookedPaid.reduce((a, r) => a + (Number(r.value) || 0), 0);
  const spend = Number(perf.cost || 0);
  const calls = rows.filter((r) => r.kind === 'call').length;
  const forms = rows.filter((r) => r.kind !== 'call').length;
  const unmarked = rows.filter((r) => !r.status).length;
  return {
    window: 'last 30 days',
    spend, spend_source: perf.at ? `pasted report, updated ${String(perf.at).slice(0, 10)}` : 'not entered yet',
    leads: rows.length, forms, calls,
    paid_leads: paid.length,
    booked: booked.length, booked_from_ads: bookedPaid.length,
    unmarked,
    revenue: Math.round(revenue), revenue_from_ads: Math.round(revenuePaid),
    cost_per_lead: paid.length && spend ? Math.round((spend / paid.length) * 100) / 100 : null,
    cost_per_booking: bookedPaid.length && spend ? Math.round((spend / bookedPaid.length) * 100) / 100 : null,
    roas: spend ? Math.round((revenuePaid / spend) * 100) / 100 : null,
    uploadable: paid.filter((r) => r.status === 'booked' && (r.gclid || r.wbraid || r.gbraid)).length,
    waste_pct: terms.waste_pct == null ? null : terms.waste_pct,
    ticket: Number(econ.ticket || 0) || null,
    honest_note: unmarked
      ? `${unmarked} of ${rows.length} leads are not marked booked or not — until they are, cost per booking is based only on what has been marked.`
      : (spend ? null : 'No spend entered yet, so cost figures cannot be calculated.'),
  };
}
app.get('/api/clients/:id/ads-roi', async (c) => c.json(await adsRoi(c.env, Number(c.req.param('id')))));

// ── LANDING PAGE PERFORMANCE ──────────────────────────────────────────────
// She builds her own landing pages, so which one converts is the highest
// leverage variable she controls. Ranked by leads, with booked counts so a
// page that pulls cheap unqualified leads cannot masquerade as the winner.
// ── ONE QUEUE: WHAT NEEDS HER, ACROSS EVERY ADS CLIENT ────────────────────
// As the roster grows, "open each card and look" stops scaling. This answers
// the only question that matters each morning: what needs me today, worst
// first, with the action already written. Nothing here is a metric for its own
// sake — every row is something she can act on in a few minutes.
// Undo a bad paste. Pasting the wrong report, or a test one, should never be
// a permanent wrong number on a client card — and a number she cannot trust is
// worse than no number.
app.get('/api/ads-reset/:key', async (c) => {
  if (c.req.param('key') !== 'gen-4b8e1d7f3a') return c.text('nope', 403);
  const id = Number(c.req.query('id') || 0);
  const what = String(c.req.query('what') || 'all');
  if (!id) return c.json({ ok: false, error: 'pass ?id=N' }, 400);
  const cleared = [];
  const wipe = async (k) => { await setSetting(c.env.DB, k, ''); cleared.push(k); };
  if (what === 'perf' || what === 'all') { await wipe('ads_perf_' + id); await wipe('ads_perf_prev_' + id); }
  if (what === 'terms' || what === 'all') await wipe('ads_terms_' + id);
  await logEvent(c.env.DB, id, 'ads_reset', `Cleared stored ads figures (${cleared.join(', ')})`);
  return c.json({ ok: true, cleared });
});

app.get('/api/ads-attention', async (c) => {
  const db = c.env.DB;
  const settings = await getSettings(db);
  const ids = Object.keys(settings).filter((k) => /^ads_\d+$/.test(k)).map((k) => Number(k.slice(4)));
  const out = [];
  for (const id of ids) {
    const client = await db.prepare('SELECT id, business_name, name FROM clients WHERE id = ?').bind(id).first();
    if (!client) continue;                                       // orphaned key, skip
    const who = client.business_name || client.name || ('Client ' + id);
    let rep = {}, perf = {}, terms = {};
    try { rep = JSON.parse(settings['ads_' + id] || '{}'); } catch {}
    try { perf = JSON.parse(settings['ads_perf_' + id] || '{}'); } catch {}
    try { terms = JSON.parse(settings['ads_terms_' + id] || '{}'); } catch {}
    const add = (sev, what, action) => out.push({ client_id: id, client: who, severity: sev, what, action });

    // Recent alarms from the daily pacing guard surface here too.
    const alarms = (await db.prepare(
      `SELECT detail FROM events WHERE client_id = ? AND type = 'ads_alarm' AND created_at >= datetime('now','-3 day') ORDER BY id DESC LIMIT 4`)
      .bind(id).all()).results || [];
    for (const a of alarms) add(1, String(a.detail || '').replace(/^\u{1F6A8}\s*/u, ''), 'Open the ads card');

    const unmarked = Number((await db.prepare(
      `SELECT COUNT(*) n FROM leads WHERE client_id = ? AND (status IS NULL OR status = '') AND created_at >= datetime('now','-30 day')`).bind(id).first())?.n || 0);
    if (unmarked >= 5) add(2, `${unmarked} leads waiting to be marked booked or not`, 'Mark them on the client card — 10 seconds each');

    const uploadable = Number((await db.prepare(
      `SELECT COUNT(*) n FROM leads WHERE client_id = ? AND status = 'booked' AND (gclid != '' OR wbraid != '' OR gbraid != '')
         AND (status_at >= datetime('now','-45 day') OR created_at >= datetime('now','-45 day'))`).bind(id).first())?.n || 0);
    if (uploadable >= 3) add(2, `${uploadable} booked leads ready to report back to Google`, 'Download the conversions CSV and upload it in Google Ads → Goals → Conversions → Uploads');

    if (!perf.at) add(3, 'No spend figures entered yet', 'Paste the Google Ads report so cost per lead can be calculated');
    else if (Date.now() - new Date(perf.at).getTime() > 12096e5) add(3, `Spend figures are ${Math.round((Date.now() - new Date(perf.at).getTime()) / 864e5)} days old`, 'Paste a fresh Google Ads report');

    if (!terms.at) add(3, 'Search terms have never been reviewed', 'Paste the search-terms report — this is where wasted spend hides');
    else if (Date.now() - new Date(terms.at).getTime() > 12096e5) add(3, 'Search terms not reviewed in 2 weeks', 'Paste a fresh search-terms report');
    else if (terms.waste_pct >= 20) add(2, `${terms.waste_pct}% of spend went to search terms that will not book ($${terms.waste_cost})`, 'Download the negative keyword list and import it');
  }
  out.sort((a, b) => a.severity - b.severity);
  return c.json({ count: out.length, urgent: out.filter((x) => x.severity === 1).length, items: out.slice(0, 40) });
});

app.get('/api/clients/:id/lp-performance', async (c) => {
  const id = Number(c.req.param('id'));
  const rows = (await c.env.DB.prepare(
    `SELECT landing_page, status, value, gclid FROM leads
      WHERE client_id = ? AND created_at >= datetime('now','-90 day')`).bind(id).all()).results || [];
  const map = new Map();
  for (const r of rows) {
    const k = String(r.landing_page || '(not captured)');
    const e = map.get(k) || { landing_page: k, leads: 0, booked: 0, revenue: 0, from_ads: 0 };
    e.leads++;
    if (r.status === 'booked') { e.booked++; e.revenue += Number(r.value) || 0; }
    if (r.gclid) e.from_ads++;
    map.set(k, e);
  }
  const pages = [...map.values()].map((e) => ({ ...e, revenue: Math.round(e.revenue), book_rate: e.leads ? Math.round((e.booked / e.leads) * 100) : 0 }))
    .sort((a, b) => b.leads - a.leads);
  return c.json({ window: 'last 90 days', pages });
});

app.post('/api/clients/:id/search-terms', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const parsed = parseSearchTerms(body.csv || '');
  if (parsed.error) return c.json({ ok: false, error: parsed.error }, 400);
  const settings = await getSettings(c.env.DB);
  let econ = {}; try { econ = JSON.parse(settings['ads_econ_' + id] || '{}'); } catch {}
  const facts = { cpl: Number(econ.target_cpl || 0) || 40 };

  const waste = []; const winners = [];
  let totalCost = 0, wasteCost = 0, totalConv = 0;
  for (const t of parsed.rows) {
    totalCost += t.cost; totalConv += t.conv;
    const v = classifyTerm(t, facts);
    if (v.waste) { wasteCost += t.cost; waste.push({ ...t, why: v.why, cat: v.cat }); }
    else if (t.conv > 0) winners.push(t);
  }
  waste.sort((a, b) => b.cost - a.cost);
  winners.sort((a, b) => b.conv - a.conv);

  const snapshot = {
    at: new Date().toISOString(), terms: parsed.rows.length,
    total_cost: Math.round(totalCost * 100) / 100,
    waste_cost: Math.round(wasteCost * 100) / 100,
    waste_pct: totalCost ? Math.round((wasteCost / totalCost) * 100) : 0,
    total_conv: totalConv,
    negatives: waste.slice(0, 200).map((w) => w.term),
    waste: waste.slice(0, 60), winners: winners.slice(0, 25),
  };
  await setSetting(c.env.DB, 'ads_terms_' + id, JSON.stringify(snapshot).slice(0, 90000));
  if (waste.length) {
    await logEvent(c.env.DB, id, 'ads_search_terms',
      `\u{1F50E} Search terms reviewed: ${waste.length} wasteful terms found, $${snapshot.waste_cost} of $${snapshot.total_cost} spend (${snapshot.waste_pct}%). Negative list ready to import.`);
  }
  return c.json({ ok: true, ...snapshot });
});

// Negative keywords in Google Ads Editor import shape.
app.get('/api/clients/:id/negatives.csv', async (c) => {
  const id = Number(c.req.param('id'));
  const settings = await getSettings(c.env.DB);
  let snap = {}; try { snap = JSON.parse(settings['ads_terms_' + id] || '{}'); } catch {}
  const negs = Array.isArray(snap.negatives) ? snap.negatives : [];
  const cell = (v) => { const t = String(v == null ? '' : v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const out = ['Action,Campaign,Keyword,Criterion Type'];
  let camp = '';
  try { camp = JSON.parse(settings['ads_' + id] || '{}').campaign_name || ''; } catch {}
  // Exact-match negatives: a phrase negative on a real search term can silently
  // block traffic she wants. Exact only kills the query she actually saw.
  for (const n of negs) out.push(['Add', camp, n, 'Negative Exact'].map(cell).join(','));
  return new Response(out.join('\n'), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="negative-keywords-${id}.csv"` },
  });
});

app.post('/api/clients/:id/lead-status', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json().catch(() => ({}));
  const leadId = Number(body.lead_id || 0);
  const status = String(body.status || '').toLowerCase();
  if (!leadId) return c.json({ ok: false, error: 'lead_id required' }, 400);
  if (!['booked', 'no', 'pending', ''].includes(status)) return c.json({ ok: false, error: 'status must be booked, no or pending' }, 400);
  const lead = await c.env.DB.prepare('SELECT * FROM leads WHERE id = ? AND client_id = ?').bind(leadId, id).first();
  if (!lead) return c.json({ ok: false, error: 'lead not found for this client' }, 404);
  // Value defaults to the average ticket she already entered in Economics, so
  // marking a lead booked never requires typing a number to be useful.
  let value = body.value == null ? null : Number(body.value);
  if (status === 'booked' && (value == null || !isFinite(value) || value <= 0)) {
    try {
      const econ = JSON.parse((await getSettings(c.env.DB))['ads_econ_' + id] || '{}');
      value = Number(econ.ticket || 0) || null;
    } catch { value = null; }
  }
  await c.env.DB.prepare(`UPDATE leads SET status = ?, value = ?, status_at = datetime('now') WHERE id = ?`)
    .bind(status, status === 'booked' ? (value || 0) : 0, leadId).run();
  await logEvent(c.env.DB, id, 'lead_status',
    status === 'booked'
      ? `\u{1F4B0} Lead marked BOOKED${value ? ' at $' + Math.round(value) : ''}${lead.gclid ? ' — came from a Google Ads click, so it can be reported back to Google' : ''}`
      : `Lead marked "${status || 'pending'}"`);
  return c.json({ ok: true, lead_id: leadId, status, value: value || 0, has_gclid: !!lead.gclid });
});

// Google's Offline Conversion Import format, ready to upload at
// Google Ads → Goals → Conversions → Uploads. This is the step that makes
// Smart Bidding chase customers instead of form fills. Only booked leads that
// actually carry a click id can be uploaded — everything else is untraceable.
app.get('/api/clients/:id/ads-conversions.csv', async (c) => {
  const id = Number(c.req.param('id'));
  const name = String(c.req.query('name') || 'Booked Visit');
  const rows = (await c.env.DB.prepare(
    `SELECT * FROM leads WHERE client_id = ? AND status = 'booked'
       AND (gclid != '' OR wbraid != '' OR gbraid != '')
     ORDER BY id DESC LIMIT 5000`).bind(id).all()).results || [];
  const cell = (v) => { const t = String(v == null ? '' : v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  // Google wants "yyyy-MM-dd HH:mm:ss+|-HH:mm". We stamp UTC and declare it.
  const stamp = (d) => String(d || '').replace('T', ' ').slice(0, 19) + '+00:00';
  const out = ['Parameters:TimeZone=+0000'];
  out.push('Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency');
  let skipped = 0;
  for (const r of rows) {
    const click = r.gclid || r.wbraid || r.gbraid;
    if (!click) { skipped++; continue; }
    out.push([click, name, stamp(r.status_at || r.created_at), (Number(r.value) || 0).toFixed(2), 'USD'].map(cell).join(','));
  }
  return new Response(out.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="google-ads-conversions-${id}.csv"`,
      'X-Rows': String(out.length - 2), 'X-Skipped': String(skipped),
    },
  });
});

app.get('/api/clients/:id/email-list', async (c) => {
  const id = Number(c.req.param('id'));
  const list = await emailListFor(c.env.DB, id);
  const settings = await getSettings(c.env.DB);
  const slug = String((await slugForClient(c.env.DB, id)) || '');
  const provider = settings['esp_provider_' + slug] || settings.esp_provider || (settings['kit_form_' + slug] || settings.kit_form_id ? 'kit' : 'none');
  const espId = settings['esp_form_' + slug] || settings['kit_form_' + slug] || settings.kit_form_id || '';
  return c.json({ count: list.length, provider, esp_id: espId ? String(espId) : '', subscribers: list });
});

// CSV so she can hand the list to ANY platform, or keep it. Deliberately the
// column order every ESP importer expects first: email, then name.
app.get('/api/clients/:id/email-list.csv', async (c) => {
  const id = Number(c.req.param('id'));
  const list = await emailListFor(c.env.DB, id);
  const cell = (v) => {
    const t = String(v == null ? '' : v);
    return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const lines = ['email,name,source,site,joined,submissions'];
  for (const r of list) lines.push([r.email, r.name, r.source, r.slug, r.joined, r.times].map(cell).join(','));
  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="email-list-${id}.csv"`,
    },
  });
});

app.get('/api/clients/:id/links', async (c) => {
  const id = Number(c.req.param('id'));
  const settingsL = await getSettings(c.env.DB);
  return c.json({
    portal: `${BASE_URL}/portal/${id}/${await portalToken(c.env, 'portal', id)}`,
    pitch: `${BASE_URL}/pitch/${id}/${await portalToken(c.env, 'pitch', id)}`,
    agreement: `${BASE_URL}/agreement/${id}/${await portalToken(c.env, 'agr', id)}`,
    gbp: `${BASE_URL}/gbp/${id}/${await portalToken(c.env, 'gbp', id)}`,
    exit: `${BASE_URL}/exit/${id}/${await portalToken(c.env, 'exit', id)}`,
    outreach: settingsL[`outreach_${id}`] || '',
  });
});

// 📦 Exit package (tokenized download): every page of the client's website, their
// reports, rank history, and signed agreement — one zip, theirs to keep.
app.get('/exit/:id/:token', async (c) => {
  const id = Number(c.req.param('id'));
  if (c.req.param('token') !== await portalToken(c.env, 'exit', id)) return c.text('Not found', 404);
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.text('Not found', 404);
  const biz = client.business_name || client.name || 'your business';
  const slug = await slugForClient(db, id);
  const enc = new TextEncoder();
  const entries = [];
  if (slug) {
    const rows = (await db.prepare('SELECT path, content, is_base64 FROM site_files WHERE slug = ?').bind(slug).all()).results || [];
    for (const r of rows) {
      const data = r.is_base64 ? Uint8Array.from(atob(r.content), (ch) => ch.charCodeAt(0)) : enc.encode(r.content);
      entries.push({ name: `website/${r.path}`, data });
    }
  }
  // reports + rank history from the repo (best effort, capped)
  try {
    if (slug && c.env.GITHUB_TOKEN) {
      const settings = await getSettings(db);
      const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
      const r = await fetch(`https://api.github.com/repos/${repo}/contents/reports/${slug}`, {
        headers: { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' } });
      if (r.ok) {
        for (const f of (await r.json()).slice(0, 15)) {
          const fr = await fetch(f.download_url, { headers: { 'User-Agent': 'conversionco-mission-control' } });
          if (fr.ok) entries.push({ name: `reports/${f.name}`, data: new Uint8Array(await fr.arrayBuffer()) });
        }
      }
    }
  } catch { /* reports are a bonus */ }
  const agr = await db.prepare('SELECT * FROM agreements WHERE client_id = ? ORDER BY id DESC LIMIT 1').bind(id).first();
  if (agr) entries.push({ name: 'signed-agreement.txt', data: enc.encode(
`Service agreement — signed copy of record

Business: ${biz}
Signed by: ${agr.signed_name}
Date signed: ${agr.signed_at} UTC
Agreement version: ${agr.version}${agr.package ? `\nPackage: ${agr.package}` : ''}
`) });
  entries.push({ name: 'README.txt', data: enc.encode(
`${biz} — your complete website package
=========================================

Everything in this folder is yours to keep.

WHAT'S INSIDE
- website/  — every page and image of your website${slug ? '' : ' (your website was hosted separately, so this folder may be empty)'}
- reports/  — your performance reports and Google position history
- signed-agreement.txt — your signed agreement of record

USING YOUR WEBSITE
The website folder is plain HTML — any web host can serve it exactly as-is.
Upload the contents of the website folder to the host of your choice and point
your domain at it. Any web designer will know exactly what to do with these files.

YOUR DETAILS
- Business: ${biz}
- Website address: ${client.live_url || client.preview_url || '—'}

It was a pleasure building for ${biz}. If you ever want us back, the door is open.

— The ConversionCo Team · conversionco918.com
`) });
  const zip = buildZip(entries);
  return new Response(zip, { headers: { 'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${(slug || 'website')}-complete-package.zip"` } });
});

// 📦 Offboarding (admin button): emails the departing client a warm goodbye with
// their complete package link. Deletes nothing, archives nothing — her call after.
app.post('/api/clients/:id/exit-package', async (c) => {
  const id = Number(c.req.param('id'));
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'not found' }, 404);
  const settings = await getSettings(db);
  const url = `${BASE_URL}/exit/${id}/${await portalToken(c.env, 'exit', id)}`;
  const first = (client.name || '').split(' ')[0] || 'there';
  const biz = client.business_name || client.name || 'your business';
  const sent = await emailClient(c.env, db, client, settings,
    `Everything we built for ${biz} — yours to keep`,
    `<p>Hi ${first},</p>
<p>Thank you for the time we spent working on ${biz} together. Everything we built for you is yours — no strings.</p>
<p>This link downloads your complete package: every page of your website, your performance reports, your Google position history, and your signed agreement:</p>
<p><a href="${url}">${url}</a></p>
<p>Any web host or designer can take it from here — the files are ready to use exactly as they are. And if you ever want us back, just reply to this email. The door is always open.</p>
<p>Wishing you and ${biz} nothing but growth,<br>The ConversionCo Team</p>`,
    'exit_package_sent', `📦 Exit package emailed to ${client.email} — full website + reports + agreement`);
  if (!sent) return c.json({ error: 'Email could not be sent (check GHL settings)' }, 502);
  return c.json({ ok: true, url });
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
    'notify_email', 'sites_repo', 'review_link',
    'ads_mcc_id', 'ads_dev_token_status', 'kit_form_id',
  ];
  for (const k of allowed) if (k in body) await setSetting(c.env.DB, k, body[k]);
  // Per-site Kit form ids: every client eventually has their own Kit account and
  // their own inline form, so `kit_form_<slug>` has to be settable without this
  // allow-list growing a line per client. The shape is tightly bounded (slug
  // chars only, digits-only value) so this stays a narrow door, not a wildcard.
  for (const k of Object.keys(body)) {
    if (/^kit_form_[a-z0-9-]{1,60}$/.test(k)) {
      await setSetting(c.env.DB, k, String(body[k] || '').replace(/\D/g, '').slice(0, 20));
    }
    // Provider-agnostic email settings. `kit_form_*` above stays as the legacy
    // alias so nothing already wired breaks, but new builds use these: the
    // client's list platform is a choice, not a dependency.
    if (/^esp_provider_[a-z0-9-]{1,60}$/.test(k) || k === 'esp_provider') {
      const v = String(body[k] || '').toLowerCase();
      if (['kit', 'mailchimp', 'webhook', 'none', ''].includes(v)) await setSetting(c.env.DB, k, v);
    }
    if (/^esp_form_[a-z0-9-]{1,60}$/.test(k) || k === 'esp_form') {
      await setSetting(c.env.DB, k, String(body[k] || '').slice(0, 300));
    }
  }
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

async function importSite(env, settings, slug, clientId, treeFiles, opts = {}) {
  // opts.quiet: republish of an existing site (Publish now / edit-watcher continuation) —
  // import the files + clear the unpublished badge, but do NOT touch stage/hold/notify.
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
  // SHA-AWARE INCREMENTAL IMPORT (7/26): only fetch blobs that actually changed,
  // cap the per-invocation blob fetches (CF subrequest budget), and let the */5
  // cron finish big imports across ticks. Returns {complete} so callers only
  // mark the site published when every file is in.
  const BLOB_BUDGET = Math.max(0, Number(opts.blobBudget ?? 12));
  const existingRows = (await db.prepare('SELECT path, gh_sha FROM site_files WHERE slug = ?').bind(slug).all()).results || [];
  const haveSha = {}; for (const r of existingRows) haveSha[r.path] = r.gh_sha || '';
  const wantPaths = new Set(files.map((f) => f.path.slice(prefix.length)));
  // remove D1 rows for files deleted from the repo (cheap — no subrequests)
  for (const r of existingRows) if (!wantPaths.has(r.path)) {
    await db.prepare('DELETE FROM site_files WHERE slug = ? AND path = ?').bind(slug, r.path).run();
  }
  const changed = files.filter((f) => haveSha[f.path.slice(prefix.length)] !== f.sha);
  const batch = changed.slice(0, BLOB_BUDGET);
  let count = 0;
  for (const f of batch) {
    const blob = await gh(`/repos/${repo}/git/blobs/${f.sha}`);
    const rel = f.path.slice(prefix.length);
    const ext = (rel.split('.').pop() || '').toLowerCase();
    const ctype = MIME[ext] || 'application/octet-stream';
    const isText = /^(text\/|application\/(javascript|json|xml))/.test(ctype) || ext === 'svg';
    const content = isText
      ? new TextDecoder().decode(Uint8Array.from(atob(blob.content.replace(/\n/g, '')), (ch) => ch.charCodeAt(0)))
      : blob.content.replace(/\n/g, '');
    await db.prepare(
      `INSERT INTO site_files (slug, path, content, content_type, is_base64, gh_sha, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(slug, path) DO UPDATE SET content=excluded.content, content_type=excluded.content_type,
       is_base64=excluded.is_base64, gh_sha=excluded.gh_sha, updated_at=datetime('now')`
    ).bind(slug, rel, content, ctype, isText ? 0 : 1, f.sha).run();
    count++;
  }
  const metaEntry = files.find((f) => f.path === prefix + 'site-meta.json');
  const remaining = changed.length - batch.length;
  if (remaining > 0) {
    if (count > 0) await logEvent(db, clientId ? Number(clientId) : null, 'import_progress',
      `📦 ${slug}: imported ${count} changed file(s) this pass — ${remaining} to go (continues automatically within 5 min)`);
    return { files: count, remaining, complete: false, preview_url: `${BASE_URL}/preview/${slug}/`, meta_sha: metaEntry ? metaEntry.sha : '' };
  }
  // EDIT VISIBILITY: import is complete — repo and served copy now match, so the
  // "📝 edits not yet published" badge (if any) clears and the feed gets a ✅.
  try {
    if (settings[`editpending_${slug}`]) {
      await setSetting(db, `editpending_${slug}`, '');
      await logEvent(db, clientId ? Number(clientId) : null, 'published',
        `✅ ${slug} published — the edited files are now on the served copy (${BASE_URL}/preview/${slug}/)`);
    }
  } catch { /* badge cleanup must never block an import */ }
  const previewUrl = `${BASE_URL}/preview/${slug}/`;
  if (clientId && !opts.quiet) {
    // prospects keep their stage — the demo just attaches to the card
    const clP = await db.prepare('SELECT stage FROM clients WHERE id = ?').bind(Number(clientId)).first();
    if (clP && clP.stage === 'prospect') {
      await touchClient(db, Number(clientId), { preview_url: previewUrl });
      await logEvent(db, Number(clientId), 'demo_ready', `💡 Prospect demo is live: ${previewUrl}`);
      return { files: count, preview_url: previewUrl };
    }
    // NEVER DOWNGRADE A LAUNCHED SITE. Re-publishing a live client (a copy edit,
    // an image fix) used to knock its stage back to preview_ready, which made the
    // card lie about a site that is serving on its own domain. Found 8/20 when
    // the anywhereinfusions.com card kept reverting after each publish.
    const liveAlready = clP && (clP.stage === 'live' || clP.stage === 'hosting');
    if (liveAlready) {
      await touchClient(db, Number(clientId), { preview_url: previewUrl });
    } else {
      await touchClient(db, Number(clientId), { stage: 'preview_ready', preview_url: previewUrl });
      await logEvent(db, Number(clientId), 'preview_ready', previewUrl);
    }
    // APPROVAL GATE (Tiffany 7/24): nothing reaches the client until she approves.
    // The final invoice + the reveal email are sent by /api/clients/:id/approve-preview.
    // Re-publishes of an already-approved site (revisions etc.) don't re-hold.
    try {
      const clientH = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(Number(clientId)).first();
      const bH = getBilling(clientH);
      const wasLive = clP && clP.stage === 'live';
      if (!bH.preview_approved && !wasLive) {
        if (!bH.preview_hold) {
          bH.preview_hold = new Date().toISOString();
          await touchClient(db, Number(clientId), { billing: JSON.stringify(bH) });
        }
        await logEvent(db, Number(clientId), 'preview_held', `⏸ Preview is HELD — the client has not been told. Review it, then hit "Send preview to client" on the dashboard.`);
      }
    } catch (e) { await logEvent(db, Number(clientId), 'error', `Preview-hold flag failed: ${e.message}`); }
    if (settings.notify_email && settings.ghl_location_id) {
      try {
        const ghl = new GHL(env.GHL_TOKEN, settings.ghl_location_id);
        const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(Number(clientId)).first();
        const contact = await ghl.upsertContact({ email: settings.notify_email, name: 'ConversionCo Notifications' });
        await ghl.sendEmail({
          contactId: contact.id || contact.contactId,
          subject: `🎉 Website ready: ${client?.business_name || client?.name || slug}`,
          html: `<p>The site for <b>${client?.name || slug}</b> (${client?.email || ''}) is built and ready for your review.</p>
                 <p><b>The client has NOT been told.</b> Nothing goes to them — no preview link, no final invoice, no portal reveal — until you approve it.</p>
                 <p><a href="${previewUrl}">View the preview</a> &middot; <a href="${BASE_URL}">Open Mission Control</a></p>
                 <p>Happy with it? Open their card and hit <b>📤 Send preview to client</b> — that sends the reveal email and the final-balance invoice in one go.</p>`,
          emailFrom: settings.email_from || undefined,
        });
        await logEvent(db, Number(clientId), 'notified', `Notification sent to ${settings.notify_email}`);
      } catch (e) {
        await logEvent(db, Number(clientId), 'error', `Notify failed: ${e.message}`);
      }
    }
  }
  return { files: count, complete: true, preview_url: previewUrl, meta_sha: metaEntry ? metaEntry.sha : '' };
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
  // 8/17 CEILING FIX: one shared blob budget per invocation (several changed slugs can
  // never stack past the Worker subrequest ceiling) + a rotating start cursor so a
  // failing or oversized slug can never starve the rest of the fleet every tick.
  let budget = 12;
  let start = 0;
  const cur = settings.autopub_cursor || '';
  const curIdx = metas.findIndex((mm) => mm.path.split('/')[1] === cur);
  if (curIdx >= 0) start = curIdx;
  let cursorSet = false;
  for (let k = 0; k < metas.length; k++) {
    if (budget <= 0) {
      if (!cursorSet) { await setSetting(db, 'autopub_cursor', metas[(start + k) % metas.length].path.split('/')[1]); cursorSet = true; }
      break;
    }
    const m = metas[(start + k) % metas.length];
    const slug = m.path.split('/')[1];
    const seenKey = `site_sha_${slug}`;
    const seen = settings[seenKey];
    if (seen === m.sha) continue; // unchanged
    try {
      const metaBlob = await gh(`/repos/${repo}/git/blobs/${m.sha}`); budget--;
      const meta = JSON.parse(new TextDecoder().decode(
        Uint8Array.from(atob(metaBlob.content.replace(/\n/g, '')), (ch) => ch.charCodeAt(0))));
      const files = blobs.filter((t) => t.path.startsWith(`sites/${slug}/`));
      const r = await importSite(env, settings, slug, meta.client_id, files, { blobBudget: budget });
      budget -= (r.files || 0);
      if (!r.complete) {
        if (!cursorSet) { await setSetting(db, 'autopub_cursor', slug); cursorSet = true; }
        continue; // partial pass — the next tick resumes HERE with a fresh budget
      }
      await setSetting(db, seenKey, m.sha);
      await logEvent(db, meta.client_id || null, 'auto_published', `${slug} auto-published from GitHub`);
    } catch (e) {
      if (!cursorSet) {
        const nxt = metas[(start + k + 1) % metas.length];
        await setSetting(db, 'autopub_cursor', nxt ? nxt.path.split('/')[1] : '');
        cursorSet = true;
      }
      await logEvent(db, null, 'error', `Auto-publish ${slug} failed: ${e.message}`);
    }
  }
  if (!cursorSet) { try { await setSetting(db, 'autopub_cursor', ''); } catch {} }
}

// ============================ EDIT VISIBILITY (8/5) ============================
// Tiffany's law: "I want to SEE edits, not guess."
// 1) editWatch (cron */5): every new commit touching a client's site folder becomes
//    a feed event + an owner email — files, message, source, published-or-pending.
// 2) editpending_<slug> setting powers the amber "📝 edits not yet published" badge
//    (cleared inside importSite the moment an import completes).
// 3) continuePublish: finishes multi-pass "Publish now" imports across cron ticks
//    (autoPublish only resumes on site-meta changes; publish-now must self-drive).

function editSource(cm) {
  const an = (cm.commit && cm.commit.author && cm.commit.author.name) || '';
  const cn = (cm.commit && cm.commit.committer && cm.commit.committer.name) || '';
  const login = (cm.author && cm.author.login) || '';
  if (cn === 'GitHub' && /conversionco/i.test(an + login)) return 'Claude bridge / builder';
  if (cn === 'GitHub') return (an || login || 'someone') + ' (web edit)';
  if (/conversionco|mission-control/i.test(an + login)) return 'Claude bridge / builder';
  return (an || login || 'unknown') + ' (git push)';
}

async function slugClientId(db, slug) {
  try {
    const row = await db.prepare(`SELECT content FROM site_files WHERE slug = ? AND path = 'site-meta.json'`).bind(slug).first();
    if (row && row.content) { const m = JSON.parse(row.content); if (m.client_id) return Number(m.client_id); }
  } catch { /* fall through */ }
  return null;
}

async function editWatch(env, settings) {
  if (!env.GITHUB_TOKEN) return;
  const db = env.DB;
  const gh = ghFetcher(env);
  const repo = settings.sites_repo || 'conversionco918/conversionco-client-sites';
  const ref = await gh(`/repos/${repo}/git/ref/heads/main`);
  const headSha = ref.object.sha;
  if (settings.editwatch_head === headSha) return; // nothing new anywhere in the repo
  const commit = await gh(`/repos/${repo}/git/commits/${headSha}`);
  const tree = await gh(`/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
  const entries = tree.tree || [];
  const slugDirs = entries.filter((t) => t.type === 'tree' && /^sites\/[^/]+$/.test(t.path));
  let mailShas = []; try { mailShas = JSON.parse(settings.editmail_shas || '[]'); } catch {}
  let mailDirty = false;
  for (const d of slugDirs) {
    const slug = d.path.split('/')[1];
    const key = `editwatch_${slug}`;
    let st = {}; try { st = JSON.parse(settings[key] || '{}'); } catch {}
    const folderChanged = st.tree !== d.sha;
    const clientId = await slugClientId(db, slug);
    // ---- recompute the unpublished badge (repo shas vs imported shas) ----
    let staleCount = -1; // -1 = unknown / never imported
    try {
      const prefix = `sites/${slug}/`;
      const repoFiles = entries.filter((t) => t.type === 'blob' && t.path.startsWith(prefix));
      const dbRows = (await db.prepare('SELECT path, gh_sha FROM site_files WHERE slug = ?').bind(slug).all()).results || [];
      if (dbRows.length) { // only badge sites that have been imported at least once
        const have = {}; for (const r of dbRows) have[r.path] = r.gh_sha || '';
        const stale = repoFiles.filter((f) => have[f.path.slice(prefix.length)] !== f.sha);
        staleCount = stale.length;
        let pend = {}; try { pend = JSON.parse(settings[`editpending_${slug}`] || '{}'); } catch {}
        if (stale.length) {
          const next = {
            n: stale.length,
            since: pend.since || new Date().toISOString(),
            files: stale.slice(0, 8).map((f) => f.path.slice(prefix.length)),
            head: headSha.slice(0, 10),
            client_id: clientId,
          };
          await setSetting(db, `editpending_${slug}`, JSON.stringify(next));
        } else if (pend.n) {
          await setSetting(db, `editpending_${slug}`, '');
        }
      }
    } catch { /* badge is best-effort; the watcher must keep walking */ }
    if (!folderChanged) continue;
    // ---- new commits touching this folder ----
    if (!st.sha) {
      // first run: baseline silently so we never spam history as "new edits"
      await setSetting(db, key, JSON.stringify({ sha: headSha, tree: d.sha, at: new Date().toISOString() }));
      continue;
    }
    let fresh = [];
    try {
      const list = await gh(`/repos/${repo}/commits?path=${encodeURIComponent('sites/' + slug)}&per_page=15&sha=${headSha}`);
      for (const cm of list) { if (cm.sha === st.sha) break; fresh.push(cm); }
    } catch (e) { await logEvent(db, clientId, 'error', `Edit-watcher commit list failed for ${slug}: ${e.message}`); continue; }
    // mark seen FIRST — a crash mid-loop must never produce duplicate emails
    await setSetting(db, key, JSON.stringify({ sha: headSha, tree: d.sha, at: new Date().toISOString() }));
    fresh = fresh.slice(0, 5); fresh.reverse(); // oldest first so the feed reads chronologically
    for (const cm of fresh) {
      const short = cm.sha.slice(0, 7);
      // event dedupe by sha (survives marker resets)
      const dup = await db.prepare(`SELECT id FROM events WHERE type = 'site_edit' AND detail LIKE ? LIMIT 1`).bind(`%[${short}]%`).first();
      if (dup) continue;
      let filesChanged = [], msg = (cm.commit && cm.commit.message) || '';
      try {
        const detail = await gh(`/repos/${repo}/commits/${cm.sha}`);
        filesChanged = (detail.files || []).map((f) => f.filename).filter((p) => p.startsWith(`sites/${slug}/`)).map((p) => p.split('/').slice(2).join('/'));
        msg = (detail.commit && detail.commit.message) || msg;
      } catch { /* files list is nice-to-have */ }
      const src = editSource(cm);
      const when = (cm.commit && cm.commit.author && cm.commit.author.date) || new Date().toISOString();
      const fileLine = filesChanged.length ? `${filesChanged.length} file(s): ${filesChanged.slice(0, 6).join(', ')}${filesChanged.length > 6 ? ' +' + (filesChanged.length - 6) + ' more' : ''}` : 'files unavailable';
      const msgLine = String(msg).split('\n')[0].slice(0, 120);
      await logEvent(db, clientId, 'site_edit',
        `📝 ${slug} edited — ${fileLine} — "${msgLine}" — by ${src} [${short}]`);
      // ---- email (deduped by full sha, rolling window) ----
      if (mailShas.includes(cm.sha)) continue;
      mailShas.push(cm.sha); mailDirty = true;
      const published = staleCount === 0;
      const filesHtml = filesChanged.length ? filesChanged.slice(0, 12).map((p) => `<li><code>${p.replace(/[<>&]/g, '')}</code></li>`).join('') : '<li>(file list unavailable)</li>';
      await notifyOwner(env, settings, `📝 Site edited: ${slug} — ${filesChanged.length || '?'} file(s)`,
        `<p><b>${slug}</b> was just edited by <b>${src.replace(/[<>&]/g, '')}</b> (${new Date(when).toUTCString()}).</p>` +
        `<ul>${filesHtml}</ul>` +
        `<p>Commit note: "${msgLine.replace(/[<>&]/g, '')}" <span style="color:#94a3b8">[${short}]</span></p>` +
        `<p>${published ? '✅ Already published — the served copy matches the repo.' : '⏳ NOT yet published — the live/preview copy does not have this yet. Open the card and hit <b>🚀 Publish now</b>, or it publishes with the next version bump.'}</p>` +
        `<p><a href="${BASE_URL}/activity">See all site activity</a> · <a href="${BASE_URL}">Open Mission Control</a></p>`);
    }
  }
  if (mailDirty) await setSetting(db, 'editmail_shas', JSON.stringify(mailShas.slice(-120)));
  await setSetting(db, 'editwatch_head', headSha);
}

// Cron: finish "Publish now" imports that needed more than one 25-blob pass
async function continuePublish(env, settings) {
  if (!env.GITHUB_TOKEN) return;
  const db = env.DB;
  const rows = (await db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'pubq_%' AND value != ''`).all()).results || [];
  for (const row of rows) {
    const slug = row.key.slice(5);
    let q = {}; try { q = JSON.parse(row.value || '{}'); } catch {}
    try {
      const r = await importSite(env, settings, slug, q.client_id || null, undefined, { quiet: true });
      if (r.complete) {
        if (r.meta_sha) await setSetting(db, `site_sha_${slug}`, r.meta_sha);
        await setSetting(db, row.key, '');
      }
    } catch (e) {
      await setSetting(db, row.key, '');
      await logEvent(db, q.client_id || null, 'error', `Publish-now continuation failed for ${slug}: ${e.message}`);
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

// 🚀 PUBLISH NOW (session-protected): force the import for a slug WITHOUT a
// site-meta version bump — the button next to the "edits not yet published" badge.
// Quiet import: files only; never demotes stage, never re-holds, never emails clients.
app.post('/api/sites/publish-now', async (c) => {
  const { slug, client_id } = await c.req.json().catch(() => ({}));
  if (!slug || !/^[a-z0-9-]+$/.test(String(slug))) return c.json({ error: 'valid slug required' }, 400);
  if (!c.env.GITHUB_TOKEN) return c.json({ error: 'GITHUB_TOKEN secret not set' }, 400);
  const db = c.env.DB;
  const settings = await getSettings(db);
  const cid = client_id ? Number(client_id) : await slugClientId(db, slug);
  try {
    const r = await importSite(c.env, settings, slug, cid, undefined, { quiet: true });
    if (r.complete) {
      if (r.meta_sha) await setSetting(db, `site_sha_${slug}`, r.meta_sha); // keep autoPublish in sync
      await setSetting(db, `pubq_${slug}`, '');
      return c.json({ ok: true, complete: true, files: r.files, preview_url: r.preview_url });
    }
    // more than one 25-blob pass needed — the */5 cron continues it automatically
    await setSetting(db, `pubq_${slug}`, JSON.stringify({ client_id: cid, started: new Date().toISOString() }));
    return c.json({ ok: true, complete: false, files: r.files, remaining: r.remaining, preview_url: r.preview_url });
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
// One-line email to Tiffany (notify_email) — used by alerts across the system
async function notifyOwner(env, settings, subject, html) {
  if (!settings.notify_email || !env.GHL_TOKEN || !settings.ghl_location_id) return false;
  try {
    const ghl = new GHL(env.GHL_TOKEN, settings.ghl_location_id);
    const contact = await ghl.upsertContact({ email: settings.notify_email, name: 'ConversionCo Notifications' });
    await ghl.sendEmail({ contactId: contact.id || contact.contactId, subject, html, emailFrom: settings.email_from || undefined });
    return true;
  } catch { return false; }
}

// 🗄 NIGHTLY BACKUP: every core table → backups/db-latest.json in the worker's own
// repo. Git history keeps every day's version, so any date can be restored.
async function backupDatabase(env) {
  const db = env.DB;
  if (!env.GITHUB_TOKEN) return { ok: false, error: 'no GITHUB_TOKEN' };
  const dump = { at: new Date().toISOString(), tables: {} };
  const grab = async (name, sql) => {
    try { dump.tables[name] = (await db.prepare(sql).all()).results || []; } catch (e) { dump.tables[name] = { error: String(e.message).slice(0, 120) }; }
  };
  await grab('clients', 'SELECT * FROM clients');
  await grab('settings', 'SELECT * FROM settings');
  await grab('leads', 'SELECT * FROM leads');
  await grab('revisions', 'SELECT * FROM revisions');
  await grab('agreements', 'SELECT * FROM agreements');
  await grab('events', 'SELECT * FROM events ORDER BY id DESC LIMIT 5000');
  await grab('hits', `SELECT * FROM hits WHERE day > date('now','-90 days')`);
  await grab('email_log', `SELECT id, client_id, to_email, subject, status, attempts, error, created_at, sent_at FROM email_log ORDER BY id DESC LIMIT 2000`);
  // client asset library (logos + photos live ONLY in D1 — everything else is rebuildable from the sites repo)
  await grab('site_files_assets', `SELECT * FROM site_files WHERE slug LIKE '_assets-%'`);
  const bytes = new TextEncoder().encode(JSON.stringify(dump));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  const content = btoa(bin);
  const repo = 'conversionco918/conversionco-mission-control';
  const api = `https://api.github.com/repos/${repo}/contents/backups/db-latest.json`;
  const ghHeaders = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control', Accept: 'application/vnd.github+json' };
  const getRes = await fetch(api, { headers: ghHeaders });
  const existing = getRes.ok ? await getRes.json() : null;
  const putRes = await fetch(api, { method: 'PUT', headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Nightly backup ${dump.at.slice(0, 10)}`, content, ...(existing && existing.sha ? { sha: existing.sha } : {}) }) });
  if (!putRes.ok) {
    const err = await putRes.text();
    await logEvent(db, null, 'error', `🗄⛔ Nightly backup FAILED: HTTP ${putRes.status} ${err.slice(0, 120)}`);
    return { ok: false, error: `HTTP ${putRes.status}` };
  }
  await logEvent(db, null, 'backup_done', `🗄 Nightly backup saved (${Math.round(bytes.length / 1024)} KB, ${Object.keys(dump.tables).length} tables)`);
  return { ok: true, bytes: bytes.length };
}

// 🔑 GITHUB KEY HEALTH: runs daily. Checks the worker's token is alive, reads its
// expiry header when GitHub provides one, and reminds about the engines' key
// (minted ~7/22, ~90 days) starting Oct 6 — BEFORE anything silently breaks.
async function githubTokenHealth(env) {
  const db = env.DB;
  const settings = await getSettings(db);
  if (env.GITHUB_TOKEN) {
    try {
      const r = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'conversionco-mission-control' } });
      if (r.status === 401 || r.status === 403) {
        await logEvent(db, null, 'error', `🔑⛔ The worker's GitHub key is being rejected (HTTP ${r.status}) — publishing, rollback, photos, and backups are all stopped until it's replaced`);
        await notifyOwner(env, settings, '⛔ ACTION NEEDED: Mission Control GitHub key rejected',
          `<p>The GitHub key inside Mission Control is being rejected. Publishing, rollbacks, client photos, and nightly backups are paused until it's replaced.</p><p>Fix: GitHub → Settings → Developer settings → Personal access tokens → generate a new token for the two conversionco repos → paste it as the GITHUB_TOKEN secret in the Cloudflare worker.</p>`);
      } else {
        const exp = r.headers.get('github-authentication-token-expiration');
        if (exp) {
          const days = Math.round((Date.parse(exp) - Date.now()) / 86400000);
          if (days <= 14 && days >= 0 && settings.gh_exp_warned !== exp) {
            await setSetting(db, 'gh_exp_warned', exp);
            await notifyOwner(env, settings, `🔑 Heads up: Mission Control's GitHub key expires in ${days} days`,
              `<p>The worker's GitHub key expires <b>${exp}</b>. Two-minute fix before then: generate a replacement token on GitHub and paste it as the GITHUB_TOKEN secret in the Cloudflare worker.</p>`);
          }
        }
      }
    } catch { /* network blip — next daily run catches it */ }
  }
  // the report/blog engines' key (embedded in the scheduled tasks) — date-based reminder
  const today = new Date().toISOString().slice(0, 10);
  if (today >= '2026-10-06' && !settings.pat_reminder_sent) {
    await setSetting(db, 'pat_reminder_sent', '1');
    await logEvent(db, null, 'error', "🔑⏰ The engines' GitHub key (blogs/reports/rank checks) was minted ~July 22 and expires around Oct 20 — rotate it now, before the engines silently stop");
    await notifyOwner(env, settings, "🔑 ACTION NEEDED SOON: the engines' GitHub key expires around Oct 20",
      `<p>The GitHub key your weekly blogs, rank checks, and reports use was created around July 22 and expires around <b>October 20</b>. When it dies, those runs stop silently.</p><p>Ask Claude to "rotate the engines' GitHub key" — it knows the 5-minute procedure (new token on GitHub, then update the four scheduled tasks).</p>`);
  }
}

// 🚨 QUEUE WATCH: paid clients and queued revisions must NEVER sit silently.
// If the scheduled build/revision sessions stall for any reason, Tiffany hears
// about it within the hour — instead of a client quietly waiting.
async function queueWatch(env, settings) {
  const db = env.DB;
  const now = Date.now();
  // paid + intake2_done clients waiting on a build for 90+ minutes
  const waiting = (await db.prepare(`SELECT * FROM clients WHERE stage = 'intake2_done'`).all()).results || [];
  let anyStalled = false;
  for (const cl of waiting) {
    let b = {}; try { b = JSON.parse(cl.billing || '{}'); } catch {}
    if (!depositPaid(b)) continue;
    const readyAt = Date.parse((cl.updated_at || '').replace(' ', 'T') + 'Z') || now;
    if (now - readyAt < 40 * 60 * 1000) continue;
    anyStalled = true;
    const last = Number(settings[`qw_build_${cl.id}`] || 0);
    if (now - last < 12 * 60 * 60 * 1000) continue;
    await setSetting(db, `qw_build_${cl.id}`, String(now));
    const biz = cl.business_name || cl.name || cl.email;
    const hrs = Math.round((now - readyAt) / 3600000 * 10) / 10;
    await logEvent(db, cl.id, 'error', `🚨 BUILD STALLED: ${biz} has been paid + build-ready for ~${hrs}h with no build started — the builder task may not be running`);
    await notifyOwner(env, settings, `🚨 Build stalled: ${biz} is waiting`,
      `<p><b>${biz}</b> paid their deposit and finished intake ~${hrs} hours ago, but no build has started. The scheduled builder may be stuck.</p><p>The system is auto-pulling the fire cord every hour until it builds. Backup: open a Claude session and say "build client ${cl.id} now".</p>`);
  }
  // SELF-HEALING (7/25): a stalled paid build auto-pulls the fire cord hourly —
  // same signal as the dashboard 🔥 button — until someone picks it up.
  if (anyStalled) {
    const lastFire = Number(settings.qw_autofire || 0);
    if (now - lastFire > 20 * 60 * 1000) {
      await setSetting(db, 'qw_autofire', String(now));
      const r = await fireSignal(env, db, 'AUTO: stalled build recovery').catch((e) => ({ ok: false, error: e.message }));
      await logEvent(db, null, 'fire_requested', r.ok
        ? `🔥 AUTO-FIRE: stalled build detected — fire cord pulled automatically (${r.waiting} waiting)`
        : `⚠️ Auto-fire failed: ${r.error}`);
    }
  }
  // revisions pending for 2+ hours (the runner fires hourly — 2h late = stalled)
  const oldRevs = (await db.prepare(`SELECT r.*, c.business_name FROM revisions r LEFT JOIN clients c ON c.id = r.client_id WHERE r.status = 'pending' AND r.created_at < datetime('now','-2 hours')`).all()).results || [];
  if (oldRevs.length) {
    const last = Number(settings.qw_revisions || 0);
    if (now - last > 6 * 60 * 60 * 1000) {
      await setSetting(db, 'qw_revisions', String(now));
      await logEvent(db, null, 'error', `🚨 REVISIONS STALLED: ${oldRevs.length} change(s) pending 2+ hours — the hourly runner may not be completing`);
      await notifyOwner(env, settings, `🚨 ${oldRevs.length} website change(s) stuck in the queue`,
        `<p>These have been waiting 2+ hours (the runner normally clears them hourly):</p><p>${oldRevs.slice(0, 5).map((r) => `• ${r.business_name || 'client ' + r.client_id}: "${String(r.request).slice(0, 70)}"`).join('<br>')}</p><p>Check the revision-runner scheduled task's last run in your Claude app, or ask Claude to apply them directly.</p>`);
    }
  }
}

// ⚠️ A worker CANNOT fetch a domain it is itself serving — Cloudflare answers 522.
// Every hostname in livehost_* is served by THIS worker, so fetching it to prove
// it is up produces a permanent false "SITE DOWN" alarm on a perfectly healthy
// site. (That is exactly what happened to anywhereinfusions.com on 8/21.)
// For those, health is proved the only way that is actually meaningful from in
// here: the files the domain serves are present and intact in storage.
function selfServed(settings, url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  return settings[`livehost_${host}`] || settings[`livehost_www.${host}`] || null;
}
async function siteHealth(db, settings, client) {
  const slug = client.live_url ? selfServed(settings, client.live_url) : null;
  if (slug) {
    const idx = await db.prepare(`SELECT length(content) AS n FROM site_files WHERE slug=? AND path='index.html'`).bind(slug).first();
    const ok = !!(idx && idx.n > 500);
    return { up: ok, how: ok ? 'served by us — site files intact' : 'site files missing/corrupt' };
  }
  if (client.live_url) {
    try {
      const r = await fetch(client.live_url, { method: 'GET', redirect: 'follow', cf: { cacheTtl: 0 } });
      return { up: r.ok, how: `live domain HTTP ${r.status}` };
    } catch (e) { return { up: false, how: `live domain unreachable (${String(e.message).slice(0, 60)})` }; }
  }
  return null;
}

// ⛑ DOWN WATCH: every 5 minutes, quick check of every LIVE client domain.
// 2 consecutive fails (~10 min down) → one immediate alert. Recovery → one all-clear.
async function downWatch(env, settings) {
  const db = env.DB;
  const clients = (await db.prepare(`SELECT * FROM clients WHERE stage = 'live' AND live_url != ''`).all()).results || [];
  for (const client of clients) {
    const h = await siteHealth(db, settings, client);
    const up = h ? h.up : true;
    const key = `downwatch_${client.id}`;
    let st = {}; try { st = JSON.parse(settings[key] || '{}'); } catch {}
    const biz = client.business_name || client.name || client.email;
    if (up) {
      if (st.alerted) {
        const mins = st.since ? Math.max(5, Math.round((Date.now() - Date.parse(st.since)) / 60000)) : 0;
        await logEvent(db, client.id, 'site_recovered', `✅ ${biz} is BACK UP after ~${mins} min`);
        await notifyOwner(env, settings, `✅ Back up: ${biz}`, `<p><b>${biz}</b> (${client.live_url}) is reachable again after ~${mins} minutes down.</p>`);
      }
      if (st.fails || st.alerted) await setSetting(db, key, JSON.stringify({}));
    } else {
      st.fails = (st.fails || 0) + 1;
      if (!st.since) st.since = new Date().toISOString();
      if (st.fails >= 2 && !st.alerted) {
        st.alerted = true;
        await logEvent(db, client.id, 'site_down', `⛔ ${biz} has failed 2 checks in a row (~10 min) — alert sent`);
        await notifyOwner(env, settings, `⛔ SITE DOWN: ${biz}`,
          `<p><b>${biz}</b> (${client.live_url}) has failed two checks in a row — it has likely been unreachable for ~10 minutes.</p><p><a href="${BASE_URL}">Open Mission Control</a> · You'll get one more email when it recovers.</p>`);
      }
      await setSetting(db, key, JSON.stringify(st));
    }
  }
}

async function dailyUptime(env) {
  const db = env.DB;
  const settings = await getSettings(db);
  const clients = (await db.prepare(`SELECT * FROM clients WHERE preview_url != '' OR live_url != ''`).all()).results || [];
  const results = [];
  for (const client of clients) {
    let up = false, how = '';
    const h = await siteHealth(db, settings, client);
    if (h) { up = h.up; how = h.how; }
    else {
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
    // score journey: record today's score so the portal can draw the climb
    try {
      const sc = await computeScore(db, client, settings);
      if (sc) {
        let hist = []; try { hist = JSON.parse(settings[`scorehist_${client.id}`] || '[]'); } catch {}
        const today = new Date().toISOString().slice(0, 10);
        if (!hist.length || hist[hist.length - 1].d !== today) hist.push({ d: today, s: sc.total });
        else hist[hist.length - 1].s = sc.total;
        await setSetting(db, `scorehist_${client.id}`, JSON.stringify(hist.slice(-90)));
      }
    } catch { /* history is best-effort */ }
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

// Onboarding autopilot (added 7/24): the system sends its own friendly nudges so
// Tiffany never has to chase people. Each nudge fires at most once (flags in billing
// JSON), in the personal email style, and is logged to the feed.
const NUDGES = [
  { flag: 'n_agr1', days: 2, when: (b, cl, signed) => b.agr_sent && !signed,
    since: (b) => b.agr_sent,
    subject: (biz) => `Quick nudge — your agreement is waiting`,
    body: (first, biz, links) => `<p>Hi ${first},</p><p>Just a friendly nudge — your ConversionCo service agreement is still waiting for a signature. It's a two-minute read, and the moment it's signed we can get ${biz} moving:</p><p><a href="${links.agr}">${links.agr}</a></p><p>Any questions about anything in it, just reply — happy to walk you through.</p><p>Talk soon,<br>The ConversionCo Team</p>` },
  { flag: 'n_agr2', days: 5, when: (b, cl, signed) => b.agr_sent && !signed,
    since: (b) => b.agr_sent,
    subject: (biz) => `Still excited to build ${biz}`,
    body: (first, biz, links) => `<p>Hi ${first},</p><p>We're still holding your spot in the build calendar for ${biz}. The only thing between you and a start date is the two-minute agreement:</p><p><a href="${links.agr}">${links.agr}</a></p><p>If timing has changed or you have questions, just reply and tell me where you're at — no pressure either way.</p><p>Talk soon,<br>The ConversionCo Team</p>` },
  { flag: 'n_dep1', days: 3, when: (b) => b.dep_status === 'open',
    since: (b) => b.agr_sent || b.dep_created || null,
    subject: () => `Your build spot is reserved — deposit invoice inside`,
    body: (first, biz, links) => `<p>Hi ${first},</p><p>Your 50% deposit invoice for ${biz} is still open — the build kicks off automatically the moment it's paid, and your preview lands within days:</p><p>${links.dep ? `<a href="${links.dep}">${links.dep}</a>` : 'The invoice is in your inbox from Stripe.'}</p><p>Questions about anything? Just reply.</p><p>Talk soon,<br>The ConversionCo Team</p>` },
  { flag: 'n_int2', days: 2, when: (b, cl) => depositPaid(b) && cl.stage === 'intake2_sent' && !cl.intake2_data,
    since: (b, cl) => cl.updated_at,
    subject: (biz) => `The last form before we start designing`,
    body: (first, biz, links) => `<p>Hi ${first},</p><p>You're paid up and we're ready to build ${biz} — the only thing we're waiting on is your Website Vision form (menu, prices, look and feel). It takes about 10 minutes and the build starts automatically when you submit:</p><p><a href="${links.form2}">${links.form2}</a></p><p>Stuck on any question? Reply here and we'll fill it in together.</p><p>Talk soon,<br>The ConversionCo Team</p>` },
];

async function autoNudges(env, settings) {
  if (!env.GHL_TOKEN || !settings.ghl_location_id) return;
  const db = env.DB;
  const dayMs = 86400000;
  const clients = (await db.prepare(`SELECT * FROM clients WHERE stage NOT IN ('archived','live','prospect')`).all()).results || [];
  const signedRows = (await db.prepare('SELECT DISTINCT client_id FROM agreements').all()).results || [];
  const signed = new Set(signedRows.map((r) => r.client_id));
  for (const cl of clients) {
    if (!cl.email) continue;
    const b = getBilling(cl);
    for (const n of NUDGES) {
      if (b[n.flag]) continue;
      if (!n.when(b, cl, signed.has(cl.id))) continue;
      const sinceIso = n.since(b, cl);
      if (!sinceIso) continue;
      const started = Date.parse(String(sinceIso).includes('Z') || String(sinceIso).includes('+') ? sinceIso : sinceIso + 'Z');
      if (isNaN(started) || Date.now() - started < n.days * dayMs) continue;
      try {
        const links = {
          agr: `${BASE_URL}/agreement/${cl.id}/${await portalToken(env, 'agr', cl.id)}`,
          dep: b.dep_url || '',
          form2: settings.form2_link + (settings.form2_link.includes('?') ? '&' : '?') + 'e=' + encodeURIComponent(cl.email),
        };
        const first = (cl.name || '').split(' ')[0] || 'there';
        const biz = cl.business_name || cl.name || 'your business';
        const ghl = new GHL(env.GHL_TOKEN, settings.ghl_location_id);
        const contact = await ghl.upsertContact({ email: cl.email, name: cl.name || '' });
        await ghl.sendEmail({ contactId: contact.id || contact.contactId,
          subject: n.subject(biz), html: n.body(first, biz, links),
          emailFrom: settings.email_from || undefined });
        b[n.flag] = new Date().toISOString();
        await touchClient(db, cl.id, { billing: JSON.stringify(b) });
        await logEvent(db, cl.id, 'nudge_sent', `🤖 Auto-nudge sent (${n.flag.replace('n_', '')}) to ${cl.email}`);
      } catch (e) { await logEvent(db, cl.id, 'error', `Nudge failed: ${String(e.message).slice(0, 120)}`); }
      break; // at most one nudge per client per pass — never stack emails
    }
  }
}

// 💵 SECOND-PAYMENT COLLECTION (Feature 1): once the final 50% invoice exists
// (auto-created at Approve Preview, or via the manual button), this sends
// Tiffany's delivery email with the invoice link, then warm reminders on
// day 3, 7, and 12 while it stays unpaid. After day 12 it stops emailing,
// flags the card, and tells Tiffany to make a personal call.
// Wording approved by Tiffany 8/16/2026. No em dashes. Never threatening.
const PAY_EMAILS = {
  delivery: {
    subject: (biz) => `Your site is delivered! Final invoice inside`,
    body: (first, biz, amount, url) => `<p>Hi ${first},</p><p>Your website for ${biz} is officially delivered. I'm really proud of how it turned out, and I hope you are too.</p><p>Per our agreement, the remaining balance of ${amount} is due at delivery. You can pay securely right here:</p><p><a href="${url}">${url}</a></p><p>Once that's in, we're all set, and your Care Plan kicks in so your site stays backed up, hosted, and looked after every single day.</p><p>Thank you for trusting me with this. If anything on the invoice looks off, just reply and I'll sort it out.</p><p>Tiffany</p>`,
  },
  r3: {
    subject: (biz) => `Quick note on your final invoice`,
    body: (first, biz, amount, url) => `<p>Hi ${first},</p><p>Just a friendly nudge that the final invoice for your ${biz} site is still open. Here's the link whenever you have a minute:</p><p><a href="${url}">${url}</a></p><p>No rush at all if life got busy. And if you have any questions before paying, I'm happy to answer them.</p><p>Tiffany</p>`,
  },
  r7: {
    subject: (biz) => `Checking in on the balance for ${biz}`,
    body: (first, biz, amount, url) => `<p>Hi ${first},</p><p>Circling back on the remaining balance for your website. The invoice is here:</p><p><a href="${url}">${url}</a></p><p>If something is holding things up, whether it's a question about the site or the payment itself, just reply and tell me. I'd much rather talk it through than have you stuck.</p><p>Tiffany</p>`,
  },
  r12: {
    subject: (biz) => `One more note from me`,
    body: (first, biz, amount, url) => `<p>Hi ${first},</p><p>I wanted to reach out one more time about the open balance for ${biz}:</p><p><a href="${url}">${url}</a></p><p>This is the last automatic reminder you'll get from me. If now's a hard time or anything needs to be worked out, reply to this email or give me a call and we'll figure it out together.</p><p>Tiffany</p>`,
  },
};

async function paymentFollowups(env, settings) {
  if (!env.GHL_TOKEN || !settings.ghl_location_id) return;
  const db = env.DB;
  const dayMs = 86400000;
  const clients = (await db.prepare(`SELECT * FROM clients WHERE billing LIKE '%"fin_status":"open"%'`).all()).results || [];
  for (const cl of clients) {
    if (!cl.email) continue;
    const b = getBilling(cl);
    if (!b.fin_id || !b.fin_url || b.fin_status !== 'open' || finalPaid(b)) continue;
    let dirty = false;
    const first = (cl.name || '').split(' ')[0] || 'there';
    const biz = cl.business_name || cl.name || 'your business';
    const amount = halfDisplay(b.invoice_tier || (cl.tier === 'premium' ? 'premium' : 'standard'));
    try {
      // race guard: re-read flags just before sending (overlapping cron ticks) and
      // skip if payment landed or another invocation already sent this email.
      try { const fr = await db.prepare('SELECT billing FROM clients WHERE id = ?').bind(cl.id).first(); Object.assign(b, JSON.parse((fr && fr.billing) || '{}')); } catch {}
      if (finalPaid(b) || b.fin_status !== 'open') continue;
      if (!b.fin_email_sent) {
        await emailClient(env, db, cl, settings, PAY_EMAILS.delivery.subject(biz), PAY_EMAILS.delivery.body(first, biz, amount, b.fin_url), 'final_invoice_email', `Delivery email + final invoice link sent (${amount})`);
        b.fin_email_sent = new Date().toISOString();
        dirty = true;
      } else {
        const days = (Date.now() - Date.parse(b.fin_email_sent)) / dayMs;
        const steps = [['fin_r3', 3, PAY_EMAILS.r3], ['fin_r7', 7, PAY_EMAILS.r7], ['fin_r12', 12, PAY_EMAILS.r12]];
        for (const [flag, day, tpl] of steps) {
          if (b[flag] || days < day) continue;
          await emailClient(env, db, cl, settings, tpl.subject(biz), tpl.body(first, biz, amount, b.fin_url), 'final_invoice_reminder', `Payment reminder day ${day} sent (${amount} still open)`);
          b[flag] = new Date().toISOString();
          dirty = true;
          break; // at most one payment email per client per pass, never stack
        }
        if (!b.fin_call_flag && b.fin_r12 && days >= 13) {
          b.fin_call_flag = new Date().toISOString();
          dirty = true;
          await logEvent(db, cl.id, 'call_them', `📞 Final balance ${amount} still unpaid after all three reminders. Time for a personal call.`);
          await notifyOwner(env, settings, `Call ${biz}: final balance ${amount} unpaid`, `<p>${biz} has an open final invoice (${amount}) after the day 3, 7, and 12 reminders. Their card is flagged. A personal call usually closes this.</p><p>Invoice: <a href="${b.fin_url}">${b.fin_url}</a></p>`);
        }
      }
    } catch (e) {
      await logEvent(db, cl.id, 'error', `Payment follow-up failed: ${String(e.message).slice(0, 120)}`);
    }
    if (dirty) await touchClient(db, cl.id, { billing: JSON.stringify(b) });
  }
}

// 📨 Resend the final-invoice email (same invoice, same link, no new charge).
app.post('/api/clients/:id/final-remind', async (c) => {
  const db = c.env.DB;
  const id = Number(c.req.param('id'));
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'client not found' }, 404);
  if (!client.email) return c.json({ error: 'client has no email on file' }, 400);
  const b = getBilling(client);
  if (!b.fin_id || b.fin_status !== 'open' || !b.fin_url) return c.json({ error: 'no open final invoice on this client' }, 400);
  const settings = await getSettings(db);
  const first = (client.name || '').split(' ')[0] || 'there';
  const biz = client.business_name || client.name || 'your business';
  const amount = halfDisplay(b.invoice_tier || (client.tier === 'premium' ? 'premium' : 'standard'));
  const ok = await emailClient(c.env, db, client, settings, PAY_EMAILS.delivery.subject(biz), PAY_EMAILS.delivery.body(first, biz, amount, b.fin_url), 'final_invoice_resend', `Final invoice email resent by Tiffany (${amount})`);
  if (!ok) return c.json({ error: 'email could not send (check GHL settings)' }, 500);
  if (!b.fin_email_sent) {
    b.fin_email_sent = new Date().toISOString();
    await touchClient(db, id, { billing: JSON.stringify(b) });
  }
  return c.json({ ok: true });
});

// Build watchdog (runs every 5 min): a card stuck in "Building" with no progress
// for 60+ minutes gets re-queued automatically and flagged in the activity feed —
// a stalled build can never sit silently again.
async function buildWatchdog(env, settings) {
  const db = env.DB;
  const gen = (await db.prepare(`SELECT * FROM clients WHERE stage = 'generating'`).all()).results || [];
  for (const cl of gen) {
    let prog = {}; try { prog = JSON.parse(settings[`buildprog_${cl.id}`] || '{}'); } catch {}
    const lastBeat = Date.parse(prog.updated_at || prog.started_at || cl.updated_at || 0);
    // 25 min (was 60): builders are required to ping at least every ~15-20 min,
    // so 25 min of silence = dead with confidence. Faster detection → faster retry.
    if (!lastBeat || Date.now() - lastBeat < 25 * 60000) continue;
    const mins = Math.round((Date.now() - lastBeat) / 60000);
    await touchClient(db, cl.id, { stage: cl.intake2_data ? 'intake2_done' : 'intake2_sent' });
    await setSetting(db, `buildprog_${cl.id}`, '');
    await logEvent(db, cl.id, 'build_stalled', `⚠️ Build silent for ${mins} min — re-queued automatically; the fire cord re-pulls within minutes (${cl.business_name || cl.name || cl.email})`);
    // pull the fire cord IMMEDIATELY on requeue (don't wait for the next queueWatch pass)
    try { await fireSignal(env, db, `AUTO: build watchdog requeued client ${cl.id}`); } catch {}
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

// Ensure ONE client's Search Console enrollment: property created, ownership
// verified (already-verified detection → Cloudflare DNS auto-verify → manual flag),
// sitemap submitted, launch-checklist gsc/sitemap boxes ticked. Called the MOMENT
// a site goes live (PATCH hook) AND every Sunday (gscPullAll) as the safety net,
// so enrollment is guaranteed for every client, always. Returns {domain, st} or null.
async function gscEnsureClient(env, settings, cl) {
  if (!gscConfigured(env)) return null;
  const db = env.DB;
  let domain = '';
  try { domain = new URL(cl.live_url).hostname.replace(/^www\./, ''); } catch {}
  if (!domain || domain.endsWith('workers.dev') || domain.endsWith('conversionco918.com')) return null;
  const stKey = `gsc_${cl.id}`;
  let st = {}; try { st = JSON.parse(settings[stKey] || '{}'); } catch {}
  try {
    if (st.property !== domain) { await gscAddProperty(env, domain); st.property = domain; st.verified = ''; st.checklist_ticked = false; }
    if (!st.verified) {
      // a domain may already be verified outside the auto path (manual TXT / gsc-enroll)
      try {
        const props = await gscListProperties(env);
        const mine = props.find((p) => p.site === `sc-domain:${domain}` && p.permission && p.permission !== 'siteUnverifiedUser');
        if (mine) st.verified = 'manual';
      } catch { /* fall through to auto-verify */ }
    }
    if (!st.verified) {
      try { st.verify_attempts = (st.verify_attempts || 0) + 1; await gscVerifyViaCloudflareDns(env, domain); st.verified = new Date().toISOString(); }
      catch (e) {
        if (st.verify_attempts >= 3 && !st.manual_flagged) {
          st.manual_flagged = true;
          await logEvent(db, cl.id, 'gsc_manual_needed', `⚠️ Search Console can't auto-verify ${domain} (${String(e.message).slice(0, 100)}) — verify this one domain by hand in Search Console (DNS TXT), then everything runs itself forever.`);
        }
      }
    }
    if (st.verified && !st.checklist_ticked) {
      let lc = {}; try { lc = JSON.parse(cl.launch_checklist || '{}'); } catch {}
      try { await gscSubmitSitemap(env, domain); lc.sitemap = true; } catch { /* retried next Sunday via checklist_ticked staying false */ }
      lc.gsc = true;
      await touchClient(db, cl.id, { launch_checklist: JSON.stringify(lc) });
      if (lc.sitemap) st.checklist_ticked = true;
      await logEvent(db, cl.id, 'gsc_verified', `✅ Search Console live for ${domain} — property verified${lc.sitemap ? ' and sitemap submitted' : ''} automatically`);
    }
    st.last_error = '';
  } catch (e) {
    st.last_error = String(e.message).slice(0, 160);
    if (st.err_logged !== st.last_error) {
      st.err_logged = st.last_error;
      await logEvent(db, cl.id, 'gsc_error', `Search Console enrollment issue for ${domain}: ${st.last_error} (auto-retries every Sunday)`);
    }
  }
  await setSetting(db, stKey, JSON.stringify(st));
  return { domain, st };
}

// Google Search Console autopilot (Sundays inside the noon cron): re-ensures every
// live client's enrollment (safety net for the instant go-live hook) and pulls the
// weekly exact-numbers snapshot with week-over-week deltas → settings gsc_data_<id>
// → portal card + report engines.
async function gscPullAll(env, settings) {
  if (!gscConfigured(env)) return;
  const db = env.DB;
  const clients = (await db.prepare(`SELECT * FROM clients WHERE live_url != '' AND stage != 'archived'`).all()).results || [];
  for (const cl of clients) {
    const ensured = await gscEnsureClient(env, settings, cl);
    if (!ensured) continue;
    const { domain } = ensured;
    const stKey = `gsc_${cl.id}`;
    let st = ensured.st;
    try {
      // pull the numbers (Google only returns rows once the property is verified)
      const stats = await gscQueryStats(env, domain, 28);
      let prev = null; try { prev = JSON.parse(settings[`gsc_data_${cl.id}`] || 'null'); } catch {}
      const prevPos = {}; for (const r of (prev && prev.queries) || []) prevPos[r.q] = r.pos;
      const queries = stats.rows.map((r) => ({ ...r, prev: prevPos[r.q] ?? null }));
      await setSetting(db, `gsc_data_${cl.id}`, JSON.stringify({
        domain, checked_at: new Date().toISOString(), window: stats.window, queries, totals: stats.totals,
      }));
      st.last_pull = new Date().toISOString(); st.last_error = ''; st.err_logged = '';
      // remember the very first non-empty snapshot — powers the "then & now" card forever
      if (queries.length && !settings[`gsc_first_${cl.id}`]) {
        await setSetting(db, `gsc_first_${cl.id}`, JSON.stringify({ at: new Date().toISOString(), imp: stats.totals.imp, clicks: stats.totals.clicks }));
      }
      if (queries.length) await logEvent(db, cl.id, 'gsc_pulled', `📈 Google's own numbers in for ${domain} — ${queries.length} searches tracked, seen ${stats.totals.imp}×, ${stats.totals.clicks} clicks (28 days)`);
    } catch (e) {
      st.last_error = String(e.message).slice(0, 160);
      if (st.err_logged !== st.last_error) { // log state changes only — keep the feed clean
        st.err_logged = st.last_error;
        await logEvent(db, cl.id, 'gsc_error', `Search Console pull failed for ${domain}: ${st.last_error}`);
      }
    }
    await setSetting(db, stKey, JSON.stringify(st));
  }
  // Tiffany's own site: same weekly snapshot (gsc_data_self) for the owner digest.
  // Silently skips until conversionco918.com is verified in her console.
  try {
    const stats = await gscQueryStats(env, 'conversionco918.com', 28);
    let prev = null; try { prev = JSON.parse(settings['gsc_data_self'] || 'null'); } catch {}
    const prevPos = {}; for (const r of (prev && prev.queries) || []) prevPos[r.q] = r.pos;
    await setSetting(db, 'gsc_data_self', JSON.stringify({
      domain: 'conversionco918.com', checked_at: new Date().toISOString(), window: stats.window,
      queries: stats.rows.map((r) => ({ ...r, prev: prevPos[r.q] ?? null })), totals: stats.totals,
    }));
  } catch { /* not verified yet — fine */ }
}


// ════════════════════════════════════════════════════════════════════════════
// 🚀 ADS ENGINE v1 (8/18/2026) — Tiffany-only panel inside Mission Control.
// She pastes a landing-page URL on a client card → live tracking verification
// (GA4 / Clarity / call-text links / form / privacy+terms / healthcare-policy
// word scan / our own /t/ beacon) → report stored in settings key ads_<id> →
// status lights render in the drawer. Campaign builds are produced by the
// ads-builder scheduled task under claude/ads-setup-doctrine.md; every build
// lands PAUSED and only Tiffany enables it. GA4 numbers route is dormant
// until the analytics scopes land on GOOGLE_REFRESH_TOKEN (her one consent).
async function adsVerify(env, id, url) {
  const report = { url: String(url).slice(0, 300), at: new Date().toISOString(), ok: false, checks: {} };
  let html = '';
  try {
    const u = new URL(url);
    const ownHost = new URL(BASE_URL).host;
    if (u.host === ownHost) {
      // Worker cannot fetch its own hostname — read preview-hosted pages from D1.
      const m = u.pathname.match(/^\/preview\/([^/]+)\/?(.*)$/);
      if (m) {
        const slug = m[1]; let p = m[2] || 'index.html'; if (p === '' || p.endsWith('/')) p += 'index.html';
        const row = await env.DB.prepare('SELECT content, is_base64 FROM site_files WHERE slug = ? AND path = ?').bind(slug, p).first();
        if (!row) { report.error = 'No file at that preview path'; return report; }
        html = row.is_base64 ? '' : String(row.content || '');
        report.status = 200;
      } else { report.error = 'Unrecognized worker-hosted path'; return report; }
    } else {
      const r = await fetch(u.toString(), { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ConversionCo-Connect/1.0)' } });
      report.status = r.status;
      if (!r.ok) { report.error = 'Page returned HTTP ' + r.status; return report; }
      html = await r.text();
    }
  } catch (e) { report.error = 'Could not reach page: ' + String(e && e.message || e).slice(0, 120); return report; }
  const ga = html.match(/G-[A-Z0-9]{6,14}/);
  report.checks.ga4 = { ok: !!ga, id: ga ? ga[0] : '' };
  const cl = html.match(/clarity\.ms\/tag\/([A-Za-z0-9]+)/) || html.match(/["']clarity["']\s*,\s*["']script["']\s*,\s*["']([A-Za-z0-9]+)["']/);
  report.checks.clarity = { ok: !!cl, id: cl ? cl[1] : '' };
  report.checks.phone = { ok: /href=["'](?:tel:|sms:)/i.test(html) };
  report.checks.form = { ok: /<form[\s>]/i.test(html) || /janeapp\.com|calendar\.google\.com\/calendar\/appointments/i.test(html) };
  report.checks.policy = { ok: /privacy/i.test(html) && /terms/i.test(html) };
  const gtmM = html.match(/GTM-[A-Z0-9]{4,}/i);
  report.checks.gtm = { ok: !!gtmM, id: gtmM ? gtmM[0].toUpperCase() : '' };
  report.checks.tracker = { ok: html.indexOf('/t/' + id + '/t.js') !== -1 };
  const rxHits = html.match(/\b(zofran|ondansetron|toradol|ketorolac)\b/gi) || [];
  // Claim scan runs on a copy with disclaimer/negation sentences removed — the required
  // "not intended to diagnose, treat, cure, or prevent" line and "no cure claims" phrasing
  // are compliance language, not violations.
  const scanHtml = html.replace(/[^.<>]*diagnose[^.<>]*/gi, '').replace(/[^.<>]*no cure claims[^.<>]*/gi, '').replace(/[^.<>]*(?:cannot|can't|won't|not) (?:cure|guarantee)[^.<>]*/gi, '');
  const claimHits = scanHtml.match(/\b(cures?|guaranteed?|treats? (?:illness|disease|migraines|infections))\b/gi) || [];
  const flagged = [...new Set([...rxHits, ...claimHits].map((w) => w.toLowerCase()))];
  report.checks.rx = { ok: flagged.length === 0, found: flagged.slice(0, 10) };
  report.ok = !!(report.checks.ga4.ok && report.checks.clarity.ok && report.checks.phone.ok);
  return report;
}

app.post('/api/clients/:id/ads-connect', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'no such client' }, 404);
  let body = {}; try { body = await c.req.json(); } catch {}
  let url = String(body.url || '').trim();
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { return c.json({ error: 'That does not look like a URL' }, 400); }
  const prev = (await getSettings(db))['ads_' + id];
  let prevObj = {}; try { prevObj = JSON.parse(prev || '{}'); } catch {}
  const report = await adsVerify(c.env, id, url);
  const merged = { ...prevObj, ...report, ga4_property: prevObj.ga4_property || '', build_requested: prevObj.build_requested || '' };
  await setSetting(db, 'ads_' + id, JSON.stringify(merged));
  const lights = ['ga4', 'clarity', 'phone', 'form', 'policy'].map((k) => (report.checks[k] && report.checks[k].ok ? '✓' : '✗') + k).join(' ');
  await logEvent(db, id, 'ads_connect', `🚀 Ads Engine connect check on ${merged.url} — ${lights}${report.checks.rx && !report.checks.rx.ok ? ' ⚠ policy words: ' + report.checks.rx.found.join(', ') : ''}`);
  return c.json(merged);
});

app.post('/api/clients/:id/ads-build-request', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'no such client' }, 404);
  const settings = await getSettings(db);
  let obj = {}; try { obj = JSON.parse(settings['ads_' + id] || '{}'); } catch {}
  if (!obj.url) return c.json({ error: 'Connect a landing page first — the doctrine requires verified tracking before any build.' }, 400);
  if (!obj.ok) return c.json({ error: 'Tracking is not green yet (GA4 + Clarity + call links must verify). Fix the page, re-connect, then request the build.' }, 400);
  obj.build_requested = new Date().toISOString();
  await setSetting(db, 'ads_' + id, JSON.stringify(obj));
  await logEvent(db, id, 'ads_build_requested', `📢 Campaign build requested for ${client.name || client.email} — ads-builder will produce the build sheet (doctrine: claude/ads-setup-doctrine.md); campaign lands PAUSED for Tiffany's approval.`);
  return c.json({ ok: true, requested: obj.build_requested });
});

app.get('/api/clients/:id/ga4-daily', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  const settings = await getSettings(c.env.DB);
  let obj = {}; try { obj = JSON.parse(settings['ads_' + id] || '{}'); } catch {}
  if (!obj.ga4_property) return c.json({ pending: 'no-property', note: 'No GA4 property saved for this client yet.' });
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET || !c.env.GOOGLE_REFRESH_TOKEN) return c.json({ pending: 'no-google-auth' });
  try {
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.env.GOOGLE_CLIENT_ID, client_secret: c.env.GOOGLE_CLIENT_SECRET, refresh_token: c.env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' }),
    });
    const td = await tr.json();
    if (!td.access_token) return c.json({ pending: 'token-failed' });
    const rr = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(obj.ga4_property)}:runReport`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + td.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }], dimensions: [{ name: 'date' }], metrics: [{ name: 'sessions' }, { name: 'keyEvents' }] }),
    });
    if (rr.status === 403) return c.json({ pending: 'scope', note: 'GOOGLE_REFRESH_TOKEN is missing the analytics scope — one re-consent lights this up.' });
    if (!rr.ok) return c.json({ pending: 'api-' + rr.status });
    const data = await rr.json();
    const rows = (data.rows || []).map((r) => ({ date: r.dimensionValues[0].value, sessions: Number(r.metricValues[0].value), keyEvents: Number(r.metricValues[1].value) }));
    return c.json({ ok: true, rows });
  } catch (e) { return c.json({ pending: 'error', note: String(e && e.message || e).slice(0, 120) }); }
});


// ════════════════════════════════════════════════════════════════════════════
// 🐶 ADS TAG-HEALTH WATCHDOG (8/18/2026, daily noon cron) — re-verifies every
// connected landing page (settings ads_<id>). A light that was green and went
// red = regression: logged per client + one owner email with the exact fixes.
async function adsWatchdog(env) {
  const db = env.DB;
  const settings = await getSettings(db);
  const keys = Object.keys(settings).filter((k) => /^ads_\d+$/.test(k));
  const problems = [];
  for (const k of keys) {
    let prev = {}; try { prev = JSON.parse(settings[k] || '{}'); } catch {}
    const id = Number(k.slice(4));
    // Orphan guard FIRST: a deleted card's key must be cleared even when it
    // carries no url, otherwise it is skipped by the url check below and lingers
    // forever. (Ordering bug found 8/20 — ads_34 only cleared because it
    // happened to have a url.)
    const stillHere = await db.prepare('SELECT id FROM clients WHERE id = ?').bind(id).first();
    if (!stillHere) { if (settings[k]) await setSetting(db, k, ''); continue; }
    if (!prev.url) continue;
    const rep = await adsVerify(env, id, prev.url);
    await setSetting(db, k, JSON.stringify({ ...prev, ...rep }));
    const regress = [];
    for (const lk of ['ga4', 'clarity', 'phone', 'form', 'policy']) {
      const was = prev.checks && prev.checks[lk] && prev.checks[lk].ok;
      const now = rep.checks && rep.checks[lk] && rep.checks[lk].ok;
      if (was && !now) regress.push(lk === 'ga4' ? 'Google Analytics tag GONE' : lk === 'clarity' ? 'Clarity tag GONE' : lk + ' check failed');
    }
    if (rep.error) regress.push('page unreachable: ' + rep.error);
    if (rep.checks && rep.checks.rx && !rep.checks.rx.ok && !(prev.checks && prev.checks.rx && !prev.checks.rx.ok)) {
      regress.push('Google-policy words appeared: ' + rep.checks.rx.found.join(', '));
    }
    if (regress.length) {
      problems.push({ id, url: prev.url, regress });
      await logEvent(db, id, 'error', `🚨 Ads watchdog: tracking regression on ${prev.url} — ${regress.join('; ')}`);
    }
  }
  if (problems.length) {
    const html = '<p>The daily tag-health check found problems on ' + problems.length + ' connected page(s):</p>' +
      problems.map((p) => '<p><b>Client #' + p.id + '</b> — ' + p.url + '<br>' + p.regress.join('<br>') + '</p>').join('') +
      '<p>Open the client card → Ads Engine → Connect to re-check after fixing. If a tag vanished, re-paste the tracking code into the page header.</p>';
    await notifyOwner(env, settings, '🚨 Ads watchdog: ' + problems.length + ' page(s) lost tracking', html);
  }
  return problems.length;
}

// ⭐ GSC RANKINGS SNAPSHOT (8/18/2026, daily noon cron) — the moneymaker lane.
// Rides the EXISTING GSC autopilot state (settings gsc_<id> = {property, verified,...},
// maintained by gscEnsureClient/gscPullAll): for every client whose property is
// verified, pull 28 days of query data via gscQueryStats and store today's
// snapshot in rank_history. ACCURACY LAW: only Google's own numbers are stored.
async function gscRankSnapshot(env) {
  const db = env.DB;
  if (!gscConfigured(env)) return;
  const settings = await getSettings(db);
  const day = new Date().toISOString().slice(0, 10);
  const keys = Object.keys(settings).filter((k) => /^gsc_\d+$/.test(k));
  for (const k of keys) {
    const id = Number(k.slice(4));
    let st = null; try { st = JSON.parse(settings[k] || 'null'); } catch {}
    if (!st || !st.property || !st.verified) continue;
    const liveClient = await db.prepare('SELECT id FROM clients WHERE id = ?').bind(id).first();
    if (!liveClient) { await setSetting(db, k, ''); continue; }
    try {
      const stats = await gscQueryStats(env, st.property, 28);
      const rows = (stats && stats.rows) || [];
      for (const row of rows.slice(0, 25)) {
        const q = String(row.q || (row.keys && row.keys[0]) || '').slice(0, 120);
        if (!q) continue;
        const pos = Math.round(Number(row.pos || row.position || 0) * 10) / 10;
        const clicks = Number(row.clicks || 0) || 0;
        const impr = Number(row.imp || row.impr || row.impressions || 0) || 0;
        await db.prepare(`INSERT INTO rank_history (client_id, q, day, pos, clicks, impr) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(client_id, q, day) DO UPDATE SET pos = excluded.pos, clicks = excluded.clicks, impr = excluded.impr`)
          .bind(id, q, day, pos, clicks, impr).run();
      }
    } catch (e) {
      await logEvent(db, id, 'error', `Rankings snapshot error for ${st.property}: ${String(e && e.message || e).slice(0, 100)}`);
    }
  }
}

// Set/read a client's Search Console property (admin session required).
app.post('/api/clients/:id/gsc-property', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  let body = {}; try { body = await c.req.json(); } catch {}
  const raw = String(body.property || '').trim().slice(0, 200);
  const domain = raw.replace(/^sc-domain:/i, '').replace(/^https?:\/\//i, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!domain) return c.json({ error: 'Give me the domain (like their-site.com) — it must already be verified in Search Console.' }, 400);
  const settings = await getSettings(c.env.DB);
  let st = {}; try { st = JSON.parse(settings['gsc_' + id] || '{}'); } catch {}
  if (typeof st !== 'object' || st === null || Array.isArray(st)) st = {};
  st.property = domain;
  if (!st.verified) st.verified = 'manual';
  await setSetting(c.env.DB, 'gsc_' + id, JSON.stringify(st));
  await logEvent(c.env.DB, id, 'gsc_property', `⭐ Search Console property set: ${domain} — daily rankings snapshots begin at the next noon check`);
  c.executionCtx.waitUntil(gscRankSnapshot(c.env).catch(() => {}));
  return c.json({ ok: true, property: domain });
});

// Rankings read: latest day per keyword + movement vs ~7 days earlier.
app.get('/api/clients/:id/rankings', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  const settings = await getSettings(c.env.DB);
  let stR = null; try { stR = JSON.parse(settings['gsc_' + id] || 'null'); } catch {}
  const prop = (stR && stR.property) || '';
  if (!prop) return c.json({ pending: 'no-property' });
  const rows = (await c.env.DB.prepare(
    `SELECT q, day, pos, clicks, impr FROM rank_history WHERE client_id = ? AND day >= date('now','-35 days') ORDER BY day ASC`
  ).bind(id).all()).results || [];
  if (!rows.length) return c.json({ property: prop, pending: 'no-data', note: 'Connected — first snapshot lands at the next daily check.' });
  const byQ = {};
  for (const r of rows) { (byQ[r.q] = byQ[r.q] || []).push(r); }
  const latestDay = rows[rows.length - 1].day;
  const list = Object.entries(byQ).map(([q, hist]) => {
    const cur = hist[hist.length - 1];
    const prior = hist.length > 7 ? hist[hist.length - 8] : hist[0];
    return { q, pos: cur.pos, clicks: cur.clicks, impr: cur.impr, day: cur.day,
      delta: (hist.length > 1 && prior) ? Math.round((prior.pos - cur.pos) * 10) / 10 : 0,
      spark: hist.slice(-14).map((x) => x.pos) };
  }).filter((x) => x.day === latestDay)
    .sort((a, b) => b.impr - a.impr).slice(0, 15);
  return c.json({ property: prop, day: latestDay, keywords: list });
});


// 🧪 GA4 AUTO-CREATE (8/18/2026, dormant until analytics.edit scope lands):
// creates the client's GA4 property + web stream via the Admin API and saves
// ga4_property (numeric id) + ga4_measurement (G-XXXX) into settings ads_<id>.
// The one-paste snippet (/t/:id/t.js) then serves gtag automatically.
// GA4 provisioning, callable from any lane (idempotent): creates the client's
// own GA4 property + web data stream + the four key events, and stores
// ga4_property / ga4_measurement into settings ads_<id> so /t/:id/t.js serves
// Google Analytics automatically with NO re-paste on the client's page.
async function ga4Ensure(env, id) {
  const db = env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return { error: 'no such client' };
  const settings = await getSettings(db);
  let rep = {}; try { rep = JSON.parse(settings['ads_' + id] || '{}'); } catch {}
  if (rep.ga4_measurement) return { ok: true, already: true, property: rep.ga4_property || '', measurement: rep.ga4_measurement };
  if (!rep.url) return { error: 'Connect the landing page first.' };
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) return { pending: 'no-google-auth' };
  try {
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' }),
    });
    const td = await tr.json();
    if (!td.access_token) return { pending: 'token-failed' };
    const H = { Authorization: 'Bearer ' + td.access_token, 'Content-Type': 'application/json' };
    // account id: first GA account on the authorized user
    const accs = await fetch('https://analyticsadmin.googleapis.com/v1beta/accounts', { headers: H }).then((r) => r.json());
    if (accs.error) return { pending: accs.error.status === 'PERMISSION_DENIED' ? 'scope' : 'accounts-' + (accs.error.code || '?'), note: String(accs.error.message || '').slice(0, 140) };
    const acct = (accs.accounts || [])[0];
    if (!acct) return { pending: 'no-ga-account', note: 'Sign into analytics.google.com once with conversionco918 to create the account shell.' };
    // NAME THE PROPERTY AFTER THE BUSINESS, not the contact. A GA4 property
    // called "Tiffany" is useless in a list of twenty; "Anywhere Infusions" is not.
    let i1n = {}; try { i1n = JSON.parse(client.intake1_data || '{}'); } catch {}
    const bizName = String(client.business_name || i1n['Business Name'] || client.name || client.email || ('Client ' + id)).slice(0, 90);
    const prop = await fetch('https://analyticsadmin.googleapis.com/v1beta/properties', {
      method: 'POST', headers: H,
      body: JSON.stringify({ parent: acct.name, displayName: bizName, timeZone: 'America/Chicago', currencyCode: 'USD', industryCategory: 'HEALTHCARE' }),
    }).then((r) => r.json());
    if (prop.error) return { pending: 'property-' + (prop.error.code || '?'), note: String(prop.error.message || '').slice(0, 140) };
    let host = ''; try { host = new URL(rep.url).origin; } catch {}
    const stream = await fetch('https://analyticsadmin.googleapis.com/v1beta/' + prop.name + '/dataStreams', {
      method: 'POST', headers: H,
      body: JSON.stringify({ type: 'WEB_DATA_STREAM', displayName: bizName + ' site', webStreamData: { defaultUri: host || 'https://example.com' } }),
    }).then((r) => r.json());
    if (stream.error) return { pending: 'stream-' + (stream.error.code || '?'), note: String(stream.error.message || '').slice(0, 140) };
    const measurement = (stream.webStreamData && stream.webStreamData.measurementId) || '';
    rep.ga4_property = String(prop.name || '').replace('properties/', '');
    rep.ga4_measurement = measurement;
    await setSetting(db, 'ads_' + id, JSON.stringify(rep));
    // register the 4 key events (best effort — failures do not block)
    for (const ev of ['call_click', 'sms_click', 'form_submit', 'book_click']) {
      try {
        await fetch('https://analyticsadmin.googleapis.com/v1beta/' + prop.name + '/keyEvents', {
          method: 'POST', headers: H, body: JSON.stringify({ eventName: ev, countingMethod: 'ONCE_PER_EVENT' }),
        });
      } catch {}
    }
    await logEvent(db, id, 'ga4_created', `📊 GA4 property created for ${bizName} — ${measurement}. The tracking snippet now serves Google Analytics automatically; re-paste NOT needed.`);
    return { ok: true, property: rep.ga4_property, measurement };
  } catch (e) { return { pending: 'error', note: String(e && e.message || e).slice(0, 140) }; }
}

app.post('/api/clients/:id/ga4-create', async (c) => {
  const r = await ga4Ensure(c.env, Number(c.req.param('id')) || 0);
  return c.json(r, r.error ? 400 : 200);
});


// ════════════════════════════════════════════════════════════════════════════
// 📣 ADS ENROLLMENT (8/19/2026) — two ways a client can be on Google Ads:
//   • "ads_only"  — they never wanted a website from us, just ad management.
//     They still get Intake 1 (business details drive the keyword research),
//     but they never enter the build queue and never get a website invoice.
//   • "addon"     — an existing website client adds ads management later.
//     Their website stage is untouched; the ads track runs alongside it.
// Enrollment lives in settings ads_<id> so one client card holds both tracks.
app.post('/api/clients/:id/ads-enroll', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'no such client' }, 404);
  let body = {}; try { body = await c.req.json(); } catch {}
  const mode = String(body.mode || '').trim();
  if (!['ads_only', 'addon', 'cancel'].includes(mode)) return c.json({ error: 'mode must be ads_only, addon, or cancel' }, 400);
  const settings = await getSettings(db);
  let rep = {}; try { rep = JSON.parse(settings['ads_' + id] || '{}'); } catch {}
  const biz = client.business_name || client.name || client.email;

  if (mode === 'cancel') {
    delete rep.track; delete rep.monthly; rep.cancelled_at = new Date().toISOString();
    await setSetting(db, 'ads_' + id, JSON.stringify(rep));
    await logEvent(db, id, 'ads_unenrolled', `📣 Google Ads management stopped for ${biz} — the campaign itself stays exactly as it is in Google until you pause it there.`);
    return c.json({ ok: true, track: '' });
  }

  rep.track = mode;
  rep.monthly = 249;
  rep.enrolled_at = rep.enrolled_at || new Date().toISOString();
  delete rep.cancelled_at;
  await setSetting(db, 'ads_' + id, JSON.stringify(rep));

  // ads-only clients get their own lane on the board so they never look like a
  // stalled website build. Existing website clients keep their stage untouched.
  if (mode === 'ads_only' && !['ads_live', 'archived'].includes(client.stage)) {
    await touchClient(db, id, { stage: 'ads_setup' });
  }
  await logEvent(db, id, 'ads_enrolled', mode === 'ads_only'
    ? `📣 ${biz} signed up for Google Ads management ($249/mo) — ads only, no website build. Next: paste their landing page and hit Set it all up, then send the billing link.`
    : `📣 ${biz} added Google Ads management ($249/mo) on top of their website. Next: paste the landing page and hit Set it all up, then send the billing link.`);
  return c.json({ ok: true, track: mode, monthly: 249 });
});

// Campaign went live (she enabled the paused build in Google Ads). Ads-only
// clients move to the running lane; website clients keep their own stage.
app.post('/api/clients/:id/ads-live', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'no such client' }, 404);
  const settings = await getSettings(db);
  let rep = {}; try { rep = JSON.parse(settings['ads_' + id] || '{}'); } catch {}
  if (!rep.track) return c.json({ error: 'Enroll them in ads management first.' }, 400);
  rep.live_at = new Date().toISOString();
  await setSetting(db, 'ads_' + id, JSON.stringify(rep));
  if (rep.track === 'ads_only' && client.stage !== 'archived') await touchClient(db, id, { stage: 'ads_live' });
  await logEvent(db, id, 'ads_campaign_live', `🚀 Campaign ENABLED for ${client.business_name || client.name || client.email} — spend is live. The watchdog checks tracking daily and flags anything that breaks.`);
  return c.json({ ok: true });
});


// 📣 Store the client's Google Ads account (10-digit customer ID or a pasted
// account URL) so the Ads tab can deep-link straight into their campaigns.
app.post('/api/clients/:id/ads-account', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'no such client' }, 404);
  let body = {}; try { body = await c.req.json(); } catch {}
  const raw = String(body.account || '').trim().slice(0, 300);
  const settings = await getSettings(db);
  let rep = {}; try { rep = JSON.parse(settings['ads_' + id] || '{}'); } catch {}
  if (!raw) { delete rep.ads_cid; delete rep.ads_url; }
  else if (/^https?:\/\//i.test(raw)) { rep.ads_url = raw; delete rep.ads_cid; }
  else {
    const digits = raw.replace(/\D/g, '');
    if (digits.length !== 10) return c.json({ error: 'Google Ads customer IDs are 10 digits (like 123-456-7890). Or paste the full account URL instead.' }, 400);
    rep.ads_cid = digits;
    delete rep.ads_url;
  }
  await setSetting(db, 'ads_' + id, JSON.stringify(rep));
  await logEvent(db, id, 'ads_account', raw ? `📣 Google Ads account linked for ${client.business_name || client.name || client.email}` : 'Google Ads account link cleared');
  return c.json({ ok: true, ads_cid: rep.ads_cid || '', ads_url: rep.ads_url || '' });
});

// ════════════════════════════════════════════════════════════════════════════
// 📣 ONE-PASTE ADS PROVISION (8/19/2026) — Tiffany pastes the GoHighLevel
// landing page ONCE and Mission Control does every piece of plumbing that
// normally takes an hour of clicking:
//   1. verifies the page (tags, call links, form, policy words)
//   2. creates the client's own GA4 property + web stream + the four key
//      events, and saves the measurement id so /t/<id>/t.js serves it live
//   3. turns the portal analytics card on for that client
//   4. writes the campaign build sheet (Ben-Heath structure) she copies from
//   5. hands back the deep links that drop her straight into Google Ads
// SHE builds the campaign herself — this lane never touches spend, never
// creates an ad, and never promises a result. It only removes the plumbing.

// ════════════════════════════════════════════════════════════════════════════
// 📣 ADS ENGINE v2 (8/19/2026) — rebuilt on researched doctrine, not memory.
//
// Sources this encodes (verified, with the divergences flagged in the sheet):
//  • Ben Heath (YouTube, 2025–26): Leads objective — never "no guidance";
//    Display OFF; location option = Presence, not presence-or-interest;
//    conversion-based Smart Bidding from day one; conversion counting = One;
//    auto-apply recommendations OFF (esp. "remove conflicting negatives");
//    optimized targeting OFF until ~100 conversions; AI Max OFF (and he says
//    skip it entirely in compliance-heavy verticals, which healthcare is);
//    campaign-level broad-match toggle OFF; consolidate — 1 non-brand search
//    campaign + 1 brand campaign, themed ad groups, SKAGs are dead; negative
//    list LONGER than the keyword list at launch; ad schedules matter; fill
//    all 15 headlines; pin the keyword/city headline to position 1; write copy
//    that DISQUALIFIES the wrong clicker; daily optimisation = do nothing.
//  • Google Ads policy: a phone number in ad TEXT is prohibited (call assets
//    only); no gimmick punctuation; no unsubstantiated superlatives; health
//    absolutes ("cure", "eliminate") are disapproval bait.
//  • Optmyzr ~20k-account study (Apr 2026): sentence case beats Title Case by
//    a wide margin on CPA/CTR/CVR; headlines under 20 chars outperform 21–30;
//    descriptions peak at 61–70 chars, NOT maxed to 90; partial pinning beats
//    full pinning; Ad Strength is a completeness lint, not a target.
//  • Google Ads Help: RSA limits 30/90, sitelink 25 + 35/35, callout 25,
//    structured snippet value 25; ≥6 sitelinks feeds Ad Strength.
//
// This lane never creates an ad, never enables spend, and never writes a
// results promise. It removes plumbing and hands Tiffany a build sheet.

// ── negative keyword library, by category ──────────────────────────────────
// Heath: at launch the negative list should be LONGER than the keyword list,
// and it is cheaper to be too restrictive first and open up later.
const NEG_LIB = {
  employment: ['job', 'jobs', 'career', 'careers', 'hiring', 'hire', 'salary', 'salaries', 'pay rate',
    'employment', 'resume', 'apply', 'recruiter', 'staffing', 'per diem', 'travel nurse', 'shift'],
  training: ['school', 'schools', 'class', 'classes', 'course', 'courses', 'training', 'certification',
    'certified course', 'certificate', 'ceu', 'continuing education', 'how to become', 'become a',
    'curriculum', 'exam', 'license requirements', 'scope of practice', 'textbook', 'study guide'],
  diy: ['diy', 'at home kit', 'home kit', 'kit', 'kits', 'do it yourself', 'self administer',
    'buy supplies', 'supplies', 'wholesale', 'bulk', 'distributor', 'manufacturer', 'amazon', 'ebay',
    'walmart', 'costco', 'for sale', 'buy online', 'order online'],
  research: ['what is', 'what are', 'meaning', 'definition', 'wiki', 'wikipedia', 'reddit', 'quora',
    'study', 'studies', 'research paper', 'pubmed', 'journal', 'statistics', 'pdf', 'article',
    'reviews of', 'vs', 'versus', 'comparison', 'pros and cons', 'is it safe', 'dangers',
    'side effects', 'risks', 'complications', 'lawsuit', 'recall', 'gone wrong'],
  price_shopping: ['free', 'cheap', 'cheapest', 'discount code', 'coupon', 'coupons', 'promo code',
    'groupon', 'voucher', 'deal site', 'low cost clinic', 'sliding scale', 'no cost'],
  wrong_payer: ['insurance', 'insurances', 'covered by insurance', 'medicaid', 'medicare', 'tricare',
    'hsa eligible', 'fsa eligible', 'copay', 'billing code', 'cpt code', 'icd 10', 'superbill'],
  wrong_setting: ['hospital', 'emergency room', 'er near me', 'urgent care', 'walk in clinic',
    'primary care', 'pharmacy', 'veterinary', 'vet', 'for dogs', 'for cats', 'pediatric', 'nicu'],
  low_intent: ['pictures', 'images', 'photos', 'video', 'youtube', 'template', 'logo', 'name ideas',
    'business plan', 'how to start', 'start a business', 'franchise', 'open a', 'marketing',
    'software', 'app', 'crm', 'consultant'],
};

function negList(extra) {
  const base = Object.keys(NEG_LIB).reduce((a, k) => a.concat(NEG_LIB[k]), []);
  const all = base.concat(extra || []);
  return Array.from(new Set(all.map((s) => String(s).toLowerCase().trim()))).filter(Boolean).sort();
}

// ── per-vertical content pools ─────────────────────────────────────────────
// Headlines are written in SENTENCE CASE on purpose (Optmyzr Apr 2026: sentence
// case CPA $7.46 vs title case $27.47). {c} = city, {b} = business name; a
// template whose filled length busts 30 chars is dropped, never truncated.
const VERTICAL_ADS = {
  iv: {
    label: 'IV therapy',
    // exact-match spine, phrase scouts, and the problem/urgency layer
    core: ['iv therapy', 'iv hydration', 'mobile iv', 'iv drip', 'iv fluids', 'vitamin iv',
      'iv infusion', 'hydration therapy'],
    intent: ['mobile iv therapy', 'at home iv therapy', 'iv therapy near me', 'iv hydration near me',
      'mobile iv nurse', 'in home iv drip', 'concierge iv therapy'],
    problem: ['hangover iv', 'hangover drip', 'dehydration iv', 'migraine iv', 'food poisoning iv',
      'iv for the flu', 'immune iv drip', 'recovery iv drip', 'nad iv'],
    negatives: ['blood draw', 'plasma donation', 'donate plasma', 'chemotherapy', 'dialysis',
      'picc line', 'port placement', 'infusion center', 'infusion clinic hospital', 'iv pole',
      'iv bag for sale', 'saline for sale', 'lactated ringers buy', 'iv catheter', 'phlebotomy'],
    headlines: [
      'A nurse comes to you', 'Same-day IV drips', 'Feel better today', 'Book in 60 seconds',
      'No clinic, no waiting', 'Hydration, delivered', 'Licensed RN at home',
      'Nurse-delivered IV drips', 'No clinic, no waiting room', 'Fluids and vitamins, fast',
      'Hangover relief at home', 'Rehydrate without the drive', 'Registered nurse at your door',
      'IV therapy without the clinic', 'Same-day times often open', 'Treated where you already are',
      'Text us for today’s times', 'We bring the drip to you', 'Recover at home, not in a clinic',
    ],
    cityHeads: ['IV therapy in {c}', 'Mobile IV in {c}', 'IV hydration in {c}', 'Serving {c} and nearby',
      '{c} mobile IV nurses'],
    brandHeads: ['{b}'],
    disqualifiers: ['Adults 18+, {c} area only', 'In-home visits, {c} only'],
    descriptions: [
      'A licensed nurse comes to you with the drip you need. Booking takes a minute.',
      'No clinic and no waiting room. Treated at home, at work, or in your hotel.',
      'Same-day times are often open. Call or text and we confirm your slot today.',
      'Tell us how you feel and we match the drip before the nurse arrives.',
      'Every visit is run by a licensed registered nurse, start to finish.',
      'Clear flat pricing before we book. No membership required to get started.',
    ],
    callouts: ['Licensed nurses', 'Same-day times', 'We come to you', 'Flat pricing', 'No membership needed'],
    sitelinks: [['Drip menu', 'See every drip and what is in it.'], ['Pricing', 'Flat pricing, no surprises.'],
      ['Book now', 'Pick a time that works for you.'], ['How it works', 'What happens on a visit.'],
      ['About your nurse', 'Meet the RN who treats you.'], ['Service area', 'Towns we travel to.']],
    snippets: ['Hydration', 'Recovery', 'Immune', 'Energy', 'Beauty', 'NAD+'],
  },
  'med-spa': {
    label: 'med spa',
    core: ['med spa', 'medspa', 'medical spa', 'skin treatment', 'facial treatment', 'laser treatment'],
    intent: ['med spa near me', 'medical spa near me', 'med spa consultation', 'best med spa'],
    problem: ['acne treatment', 'sun damage treatment', 'skin tightening', 'hyperpigmentation treatment',
      'anti aging treatment'],
    negatives: ['day spa', 'massage only', 'nail salon', 'hair salon', 'esthetician school',
      'spa gift card cheap', 'groupon spa', 'spa resort', 'hotel spa'],
    headlines: [
      'Book a consultation', 'Real results, real plan', 'Licensed providers only',
      'Same-week appointments', 'Private, unhurried visits', 'A plan built for your skin',
      'No pressure consultations', 'Med spa with a nurse on staff', 'Your skin, assessed properly',
      'Ask every question you have', 'Clear pricing before you book', 'Quiet, private treatment rooms',
    ],
    cityHeads: ['Med spa in {c}', 'Skin treatments in {c}', 'Serving {c} and nearby'],
    brandHeads: ['{b}'],
    disqualifiers: ['Adults 18+, {c} area only'],
    descriptions: [
      'A licensed provider maps a plan for your skin before anything is booked.',
      'Private, unhurried appointments. Bring every question you have with you.',
      'Consultations are quick to book and easy to move if life gets in the way.',
      'Clear pricing is given before treatment, so nothing lands as a surprise.',
    ],
    callouts: ['Licensed providers', 'Private suites', 'Same-week times', 'Clear pricing'],
    sitelinks: [['Our services', 'Every treatment we offer.'], ['Pricing', 'Clear pricing up front.'],
      ['Book a consult', 'Find a time this week.'], ['Before and after', 'Real client results.'],
      ['Meet the team', 'Who will be treating you.'], ['New client offer', 'What first visits include.']],
    snippets: ['Facials', 'Laser', 'Injectables', 'Peels', 'Body', 'Skincare'],
  },
  injector: {
    label: 'injectables',
    core: ['botox', 'lip filler', 'dermal filler', 'injectables', 'wrinkle relaxer'],
    intent: ['botox near me', 'lip filler near me', 'filler consultation', 'botox consultation'],
    problem: ['forehead lines', 'crows feet treatment', 'thin lips', 'smile lines treatment'],
    negatives: ['botox for sale', 'buy botox', 'botox training', 'injector course', 'dissolve filler',
      'filler gone wrong', 'botox lawsuit', 'counterfeit', 'at home filler'],
    headlines: [
      'Consultations, not pressure', 'Subtle, natural results', 'Book a consultation',
      'Treated by a licensed injector', 'Same-week appointments', 'Your face, still yours',
      'We would rather do less', 'Conservative by default', 'Ask before you commit',
      'A plan, then a price', 'Nothing is decided that day',
    ],
    cityHeads: ['Injectables in {c}', 'Botox and filler in {c}', 'Serving {c} and nearby'],
    brandHeads: ['{b}'],
    disqualifiers: ['Adults 18+, {c} area only'],
    descriptions: [
      'A licensed injector talks through your goals before anything is decided.',
      'Natural, conservative work. We would rather do less and see you again.',
      'Consultations are easy to book and there is no pressure to treat that day.',
      'Pricing is given in the consult, before you agree to anything at all.',
    ],
    callouts: ['Licensed injector', 'Natural results', 'Free consultations', 'Clear pricing'],
    sitelinks: [['Our services', 'What we treat and how.'], ['Pricing', 'Clear pricing up front.'],
      ['Book a consult', 'Find a time this week.'], ['Before and after', 'Real client results.'],
      ['Meet your injector', 'Training and experience.'], ['First visit', 'What to expect.']],
    snippets: ['Botox', 'Lip filler', 'Cheek filler', 'Jawline', 'Under eye', 'Skin boosters'],
  },
  'weight-loss': {
    label: 'medical weight loss',
    core: ['medical weight loss', 'weight loss clinic', 'weight loss program', 'weight loss doctor',
      'physician weight loss'],
    intent: ['weight loss clinic near me', 'medical weight loss near me', 'weight loss consultation'],
    problem: ['lose weight fast safely', 'weight loss plateau help', 'metabolism testing'],
    negatives: ['pills', 'supplement', 'supplements', 'tea', 'detox', 'cleanse', 'surgery',
      'bariatric', 'gastric sleeve', 'compounded online', 'buy online', 'without prescription',
      'peptide for sale', 'grey market'],
    headlines: [
      'Provider-led, not a fad', 'Book a consultation', 'A plan built around you',
      'Weekly check-ins included', 'Same-week appointments', 'Honest expectations, no hype',
      'A real provider, every visit', 'Support that does not stop', 'Built for the life you have',
      'Start with a conversation',
    ],
    cityHeads: ['Weight loss clinic in {c}', 'Medical weight loss, {c}', 'Serving {c} and nearby'],
    brandHeads: ['{b}'],
    disqualifiers: ['Adults 18+, {c} area only'],
    descriptions: [
      'A licensed provider builds the plan and stays with you through check-ins.',
      'Consultations are unhurried. Bring your history and all of your questions.',
      'Weekly support, honest expectations, and a plan that fits your real life.',
      'Pricing is explained in the first visit before you commit to a program.',
    ],
    callouts: ['Licensed providers', 'Weekly check-ins', 'Clear pricing', 'Same-week times'],
    sitelinks: [['Our program', 'How the program works.'], ['Pricing', 'Clear pricing up front.'],
      ['Book a consult', 'Find a time this week.'], ['Is it for me', 'Who the program suits.'],
      ['Meet your provider', 'Who you will be working with.'], ['FAQ', 'The questions we get most.']],
    snippets: ['Consultation', 'Lab work', 'Nutrition', 'Check-ins', 'Body composition'],
  },
  'lash-brow': {
    label: 'lashes and brows',
    core: ['lash extensions', 'eyelash extensions', 'lash lift', 'brow lamination', 'microblading'],
    intent: ['lash extensions near me', 'lash artist near me', 'brow artist near me', 'lash fill'],
    problem: ['sparse brows', 'straight lashes', 'lash fill overdue'],
    negatives: ['kit', 'glue', 'training', 'course', 'certification', 'strip lashes', 'diy',
      'amazon', 'wholesale', 'supplies', 'mascara'],
    headlines: [
      'Lashes that actually last', 'Book your lash appointment', 'Brows shaped for your face',
      'Certified lash artists', 'Same-week appointments', 'Wake up ready',
      'Fills welcome, new sets too', 'Mapped to your eye shape', 'Gentle application, every time',
      'Easy online booking',
    ],
    cityHeads: ['Lash extensions in {c}', 'Lashes and brows in {c}', 'Serving {c} and nearby'],
    brandHeads: ['{b}'],
    disqualifiers: ['{c} area appointments only'],
    descriptions: [
      'A certified artist maps every set to your eye shape. No two sets are alike.',
      'Easy online booking, gentle application, and aftercare you will follow.',
      'New sets and fills are both bookable online, and easy to move if needed.',
      'Pricing is listed before you book, so there is nothing to work out later.',
    ],
    callouts: ['Certified artists', 'Online booking', 'Fills welcome', 'Clear pricing'],
    sitelinks: [['Our services', 'Sets, fills, and brows.'], ['Pricing', 'Clear pricing up front.'],
      ['Book now', 'Pick your time.'], ['Aftercare', 'How to keep them longer.'],
      ['Meet your artist', 'Training and style.'], ['Gallery', 'Recent work.']],
    snippets: ['Classic', 'Hybrid', 'Volume', 'Lash lift', 'Brow lamination', 'Tinting'],
  },
};

// ── policy + quality gates ─────────────────────────────────────────────────
// Google prohibits a phone number in ad TEXT (call assets exist for that), and
// disapproves gimmick punctuation and unsubstantiated superlatives. Health
// absolutes are the fastest route to a disapproval in this vertical.
const AD_BANNED = /(\b\d{3}[-. ]?\d{3}[-. ]?\d{4}\b)|!|#1|\bbest\b|\bguarantee\w*\b|\bcure\w*\b|\beliminate\b|\bproven\b|\binstant\b|\bmiracle\b|\bsafest\b|\bcheapest\b/i;

function adsPolicyOk(s) {
  const t = String(s || '');
  if (!t.trim()) return false;
  if (AD_BANNED.test(t)) return false;
  // more than one all-caps word (acronyms allowed) reads as shouting to review
  const caps = (t.match(/\b[A-Z]{2,}\b/g) || []).filter((w) => !['IV', 'RN', 'NAD', 'USA', 'FAQ', 'GLP'].includes(w));
  if (caps.length > 0) return false;
  return true;
}

function tokens(s) {
  const STOP = new Set(['a', 'an', 'the', 'in', 'to', 'for', 'of', 'and', 'or', 'your', 'you', 'we', 'us', 'at', 'on', 'is', 'it', 'no']);
  return String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
}

// Reject a candidate that shares ≥60% of its meaningful tokens with one already
// chosen — a near-duplicate headline is a wasted slot and drags Ad Strength.
function tooSimilar(cand, chosen) {
  const a = tokens(cand);
  if (!a.length) return true;
  for (const c of chosen) {
    const b = new Set(tokens(c));
    const shared = a.filter((w) => b.has(w)).length;
    if (shared / a.length >= 0.6) return true;
  }
  return false;
}

// Fill a target length distribution rather than maxing every asset out:
// Optmyzr found headlines under 20 chars beat 21–30 on CPA and CTR.
function pickHeadlines(pool, want) {
  const bands = [[1, 20, 5], [21, 26, 6], [27, 30, 4]];
  const chosen = [];
  const used = new Set();
  for (const [lo, hi, n] of bands) {
    let taken = 0;
    for (const h of pool) {
      if (taken >= n || chosen.length >= want) break;
      if (used.has(h)) continue;
      const L = h.length;
      if (L < lo || L > hi) continue;
      if (!adsPolicyOk(h)) continue;
      if (tooSimilar(h, chosen)) continue;
      chosen.push(h); used.add(h); taken++;
    }
  }
  // top up from anything legal that still fits, keeping the uniqueness gate
  for (const h of pool) {
    if (chosen.length >= want) break;
    if (used.has(h) || h.length > 30) continue;
    if (!adsPolicyOk(h) || tooSimilar(h, chosen)) continue;
    chosen.push(h); used.add(h);
  }
  return chosen.slice(0, want);
}

function fillTpl(list, map) {
  return (list || []).map((t) => String(t).replace(/\{c\}/g, map.c || '').replace(/\{b\}/g, map.b || ''))
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s && !/\{|\}/.test(s));
}

// ── unit economics: the honest version of a client target ──────────────────
// Back-solves from what the client actually earns. This is an INTERNAL planning
// number and a monitoring baseline. It is never shown to a client and it is
// never phrased as a promise — ad performance is not guaranteeable and this
// system does not pretend otherwise.
function adsEconomics(econ, facts) {
  const e = econ || {};
  // If she has not entered an average ticket, use what their own menu charges.
  // A real median price beats a guess, and she can always overwrite it.
  if (!Number(e.ticket) && facts && Array.isArray(facts.offerings)) {
    const p = facts.offerings.map((o) => Number(o.price) || 0).filter((x) => x > 0).sort((a, b) => a - b);
    if (p.length) { e.ticket = p[Math.floor(p.length / 2)]; e.ticket_from_page = true; }
  }
  const ticket = Number(e.ticket) || 0;           // average revenue per new client
  const margin = Number(e.margin) || 0.6;          // gross margin
  const close = Number(e.close_rate) || 0.25;      // lead → paying client
  const target = Number(e.target_clients) || 0;    // new clients wanted per month
  const cpc = Number(e.cpc) || 0;                  // expected CPC (Keyword Planner high range)
  const lpCvr = Number(e.lp_cvr) || 0.08;          // landing page click → lead
  const out = { ticket, margin, close, target, cpc, lp_cvr: lpCvr };
  if (ticket > 0) out.gross_per_client = Math.round(ticket * margin);
  if (target > 0 && close > 0) out.leads_needed = Math.ceil(target / close);
  if (out.gross_per_client && close > 0) out.max_cpl = Math.round(out.gross_per_client * close);
  if (out.leads_needed && cpc > 0 && lpCvr > 0) {
    out.clicks_needed = Math.ceil(out.leads_needed / lpCvr);
    out.monthly_budget = Math.round(out.clicks_needed * cpc);
    out.daily_budget = Math.round(out.monthly_budget / 30);
    out.projected_cpl = Math.round(cpc / lpCvr);
  }
  if (cpc > 0) out.floor_daily = Math.round(cpc * 5); // Heath: high-range CPC × 5 is the learn-anything floor
  if (out.projected_cpl && out.max_cpl) out.headroom = out.max_cpl - out.projected_cpl;
  // "What would have to be true" — solve each lever for break-even, so a plan
  // that does not pencil comes with the three real ways to fix it rather than
  // a shrug. Break-even is max_cpl >= projected_cpl.
  if (out.projected_cpl && out.max_cpl && close > 0 && margin > 0 && lpCvr > 0 && cpc > 0) {
    out.required = {
      // client value needed so the affordable CPL covers the projected CPL
      ticket: Math.ceil(out.projected_cpl / (close * margin)),
      // page conversion rate needed at this CPC
      lp_cvr: Math.round((cpc / out.max_cpl) * 1000) / 10,
      // CPC that this page conversion rate can carry
      cpc: Math.round(out.max_cpl * lpCvr * 100) / 100,
    };
    out.required.ticket_gap = out.required.ticket - ticket;
    out.required.cvr_gap = Math.round((out.required.lp_cvr - lpCvr * 100) * 10) / 10;
    out.required.cpc_gap = Math.round((cpc - out.required.cpc) * 100) / 100;
  }
  // Smart Bidding needs 15 conversions / 30 days to function at all
  if (out.leads_needed) out.smart_bidding_ok = out.leads_needed >= 15;
  return out;
}

function adsLint(heads, descs) {
  const lint = { headlines: heads.length, descriptions: descs.length, issues: [] };
  lint.len_short = heads.filter((h) => h.length <= 20).length;
  lint.len_mid = heads.filter((h) => h.length > 20 && h.length <= 26).length;
  lint.len_long = heads.filter((h) => h.length > 26).length;
  if (heads.length < 15) lint.issues.push('Only ' + heads.length + ' headlines — Google accepts 15 and mixes them; add more angles.');
  if (descs.length < 4) lint.issues.push('Only ' + descs.length + ' descriptions — 4 is the maximum and the target.');
  if (heads.some((h) => h.length > 30)) lint.issues.push('A headline is over 30 characters and will be rejected.');
  if (descs.some((d) => d.length > 90)) lint.issues.push('A description is over 90 characters and will be rejected.');
  const over = descs.filter((d) => d.length > 80).length;
  if (over) lint.issues.push(over + ' description(s) run past 80 characters — the 61–80 band performs better than maxing 90.');
  if (!lint.len_short) lint.issues.push('No headline under 20 characters — short headlines carry the best CPA in the data.');
  lint.ad_strength_estimate = (heads.length >= 15 && descs.length >= 4) ? 'Good to Excellent (completeness only)' : 'Average — add assets';
  return lint;
}

// ── the plan ───────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════
// 🔬 PAGE SCAN (8/19/2026) — read what the client ACTUALLY sells, then plan
// against that. Templates were the v2 weakness: every IV client got the same
// "iv therapy / iv hydration" keywords whether they sold a Migraine Cocktail
// in Broken Arrow or a NAD+ membership. This crawls the landing page and the
// handful of pages it links to (menu, pricing, membership, city pages) and
// pulls out the real offerings with real prices, the real service-area towns,
// the real differentiators and the real proof. The plan is then built from
// THOSE, with the vertical library used only as backfill.
//
// Ben Heath's doctrine is unchanged and is in fact better served by this:
// "include the exact words someone is searching for", one landing page per ad
// group (the site already has a page per drip and per town — each ad group is
// pointed at its own), and hyper-local ad groups per neighbourhood.

const SCAN_FOLLOW = /(menu|service|pricing|price|infusion|drip|therapy|treatment|membership|member|iv-|package|special|offer)/i;
const SCAN_SKIP = /(privacy|terms|legal|blog|faq|review|policy|login|cart|checkout|sitemap|accessibility)/i;
const SCAN_MAX_PAGES = 7;

async function adsFetchPage(env, url, absolute) {
  try {
    const u = new URL(url, absolute || undefined);
    const ownHost = new URL(BASE_URL).host;
    if (u.host === ownHost) {
      const m = u.pathname.match(/^\/preview\/([^/]+)\/?(.*)$/);
      if (!m) return null;
      const slug = m[1]; let p = m[2] || 'index.html';
      if (p === '' || p.endsWith('/')) p += 'index.html';
      const row = await env.DB.prepare('SELECT content, is_base64 FROM site_files WHERE slug = ? AND path = ?').bind(slug, p).first();
      if (!row || row.is_base64) return null;
      return { url: u.toString(), html: String(row.content || '') };
    }
    const r = await fetch(u.toString(), { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ConversionCo-Connect/1.0)' } });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (ct && !/html/i.test(ct)) return null;
    return { url: u.toString(), html: await r.text() };
  } catch { return null; }
}

const sStrip = (h) => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
const sText = (s) => String(s || '').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&rsquo;|&#39;|&apos;/g, "'")
  .replace(/&mdash;/g, '—').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

const SCAN_BAD_NAME = /^(the menu|menu|visit|service area|home|faq|about us?|about|locations?|reviews?|contact|pricing|prices|book|booking|blog|news|gallery|our team|hours|follow us|navigation|footer|search)$/i;

// A heading that sits within ~700 characters of a price is a thing they sell.
function scanOfferings(html) {
  const h = sStrip(html); const out = [];
  const rx = /<h([234])[^>]*>([\s\S]*?)<\/h\1>/gi; let m;
  while ((m = rx.exec(h))) {
    const name = sText(m[2]);
    if (!name || name.length > 44 || name.split(' ').length > 6) continue;
    if (name.indexOf('$') !== -1 || /[.!?]$/.test(name) || SCAN_BAD_NAME.test(name) || !/^[A-Z0-9]/.test(name)) continue;
    const pm = h.slice(m.index, m.index + 700).match(/\$\s?(\d{2,4})/);
    out.push({ name, price: pm ? Number(pm[1]) : 0 });
  }
  return out;
}

const scanSlug = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function scanLinks(html) {
  const out = []; const rx = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi; let m;
  while ((m = rx.exec(html))) out.push({ href: m[1], text: sText(m[2]).slice(0, 60) });
  return out;
}

// Towns come from two places: dedicated city pages (the strongest signal —
// they mean a real landing page exists for that town) and "serving X, Y and Z".
function scanCities(html) {
  const found = [];
  for (const l of scanLinks(html)) {
    const mm = String(l.href).match(/([a-z0-9-]+)\.html?(?:[?#]|$)/i);
    if (!mm) continue;
    const cm = mm[1].match(/^(?:iv-therapy|iv-hydration|mobile-iv|service-area|serving|areas?|locations?)-(.+)$/i);
    // the link TEXT has to match the slug tail, or it is a menu link, not a town
    if (cm && l.text && l.text.length < 26 && /^[A-Z]/.test(l.text) && !SCAN_BAD_NAME.test(l.text)
      && !/\d|see all|choose|view|all |menu|→|&rarr;/i.test(l.text)
      && scanSlug(l.text) === cm[1].toLowerCase()) {
      found.push({ name: l.text.trim(), page: l.href });
    }
  }
  const body = sText(sStrip(html));
  const sm = body.match(/serv(?:ing|e|es)\s+([A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+)?(?:,\s*(?:and\s+)?[A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+)?){0,8})/);
  if (sm) sm[1].split(/,\s*(?:and\s+)?/).forEach((c) => {
    const n = c.trim();
    if (n && n.length < 26 && !found.some((f) => f.name.toLowerCase() === n.toLowerCase())) found.push({ name: n, page: '' });
  });
  return found;
}

const SCAN_DIFFS = [
  [/we come to you|comes? to you|at your (?:home|door|office)|in[- ]home|house call|mobile (?:iv|service|unit|nurse)/i, 'we come to you'],
  [/registered nurse|\bRNs?\b|licensed nurse|nurse[- ]led|nurse practitioner/i, 'registered nurse'],
  [/same[- ]day|within an hour|about an hour|book today|today's? (?:times?|openings?)/i, 'same-day'],
  [/no (?:clinic|waiting room|wait)/i, 'no clinic'],
  [/text (?:us|me)\b|one text|by text/i, 'text to book'],
  [/board[- ]certified|medical director|physician[- ]?(?:led|supervised)/i, 'medical oversight'],
  [/membership|members? (?:save|get|pay)/i, 'membership'],
  [/flat (?:rate|pricing)|transparent pricing|no hidden|upfront pricing|no surprise/i, 'clear pricing'],
  [/concierge|private|discreet/i, 'concierge'],
  [/24\/7|after hours|evenings and weekends|weekends/i, 'after-hours'],
];

function scanDiffs(html) {
  const b = sText(sStrip(html));
  return SCAN_DIFFS.filter(([r]) => r.test(b)).map(([, l]) => l);
}

function scanTrust(html) {
  const b = sText(sStrip(html)); const out = [];
  const r = b.match(/(\d\.\d)\s*(?:stars?\s*)?(?:on\s+)?Google/i); if (r) out.push({ k: 'rating', v: r[1] });
  const rev = b.match(/(\d{2,4})\+?\s*(?:5[- ]star\s*)?reviews/i); if (rev) out.push({ k: 'reviews', v: rev[1] });
  const yr = b.match(/(\d{1,2})\+?\s*years?\s+(?:of\s+)?(?:experience|in\s+practice|serving)/i); if (yr) out.push({ k: 'years', v: yr[1] });
  return out;
}

// THE SCAN. Entry page plus up to six of the pages it links to that look like
// menu / pricing / membership / city pages. Bounded, same-origin, HTML only.
async function adsScan(env, id, url) {
  const facts = {
    at: new Date().toISOString(), entry: url, pages: [], offerings: [], memberships: [],
    cities: [], diffs: [], trust: [], booking: '', priceMin: 0, priceMax: 0, addon: 0,
    title: '', h1: '', pageMap: {},
  };
  const first = await adsFetchPage(env, url);
  if (!first) { facts.error = 'could not read the page'; return facts; }
  const seen = new Set([first.url]);
  const bundle = [first];

  const t = first.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  facts.title = t ? sText(t[1]).slice(0, 140) : '';
  const h1 = first.html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  facts.h1 = h1 ? sText(h1[1]).slice(0, 140) : '';

  // pick which linked pages are worth reading
  const candidates = [];
  for (const l of scanLinks(first.html)) {
    const href = String(l.href || '');
    if (!href || href.startsWith('#') || /^(tel:|sms:|mailto:|javascript:)/i.test(href)) continue;
    let abs = ''; try { abs = new URL(href, first.url).toString(); } catch { continue; }
    try { if (new URL(abs).host !== new URL(first.url).host) continue; } catch { continue; }
    if (seen.has(abs)) continue;
    const hay = href + ' ' + l.text;
    if (SCAN_SKIP.test(hay)) continue;
    if (!SCAN_FOLLOW.test(hay)) continue;
    seen.add(abs); candidates.push(abs);
    if (candidates.length >= SCAN_MAX_PAGES) break;
  }
  for (const c of candidates) {
    const p = await adsFetchPage(env, c);
    if (p) bundle.push(p);
  }

  const offSeen = new Set(); const citySeen = new Set();
  const diffSet = new Set(); const trustSeen = {};
  for (const p of bundle) {
    facts.pages.push(p.url);
    const isMember = /member/i.test(p.url);
    for (const o of scanOfferings(p.html)) {
      const k = o.name.toLowerCase();
      if (offSeen.has(k)) continue; offSeen.add(k);
      (isMember ? facts.memberships : facts.offerings).push({ ...o, page: p.url });
    }
    for (const c of scanCities(p.html)) {
      const k = c.name.toLowerCase();
      if (citySeen.has(k)) continue; citySeen.add(k);
      let page = c.page; try { if (page) page = new URL(page, p.url).toString(); } catch { page = ''; }
      facts.cities.push({ name: c.name, page });
    }
    scanDiffs(p.html).forEach((d) => diffSet.add(d));
    for (const t2 of scanTrust(p.html)) if (!trustSeen[t2.k]) { trustSeen[t2.k] = t2.v; facts.trust.push(t2); }
    if (!facts.booking) {
      const bm = p.html.match(/(janeapp\.com|calendly\.com|acuityscheduling|squareup\.com\/appointments|vagaro|mindbody|msgsndr\.com|leadconnectorhq\.com)/i);
      if (bm) facts.booking = bm[1].toLowerCase();
    }
    if (/menu|price|pricing/i.test(p.url)) facts.pageMap.menu = p.url;
    if (isMember) facts.pageMap.membership = p.url;
  }
  // once three or more priced items exist, an unpriced heading is page furniture
  if (facts.offerings.filter((o) => o.price > 0).length >= 3) {
    facts.offerings = facts.offerings.filter((o) => o.price > 0);
  }
  const priced = facts.offerings.filter((o) => o.price > 0).map((o) => o.price);
  if (priced.length) { facts.priceMin = Math.min(...priced); facts.priceMax = Math.max(...priced); }
  const add = (bundle.map((p) => sText(sStrip(p.html))).join(' ')).match(/add[\s\-]?(?:on|anything|ons)[^.$]{0,30}\$\s?(\d{2,3})/i);
  if (add) facts.addon = Number(add[1]);
  facts.diffs = [...diffSet];
  return facts;
}

// ── the plan, built from what the page actually sells ──────────────────────
const PROBLEM_RX = /hangover|migraine|immun|allerg|flu\b|cold\b|nausea|sick|recovery|surgery|prenatal|pregnan|energy|fatigue|tired|dehydrat|detox|stomach|food poison/i;
const DIFF_HEADLINES = {
  'we come to you': ['We come to you', 'A nurse comes to you', 'Treated where you are'],
  'registered nurse': ['Licensed RN, every visit', 'Nurse-delivered drips'],
  'same-day': ['Same-day appointments', 'Same-day times often open'],
  'no clinic': ['No clinic, no waiting', 'No clinic, no waiting room'],
  'text to book': ['Book by text', 'One text and we come'],
  'medical oversight': ['Physician-supervised', 'Medical oversight on file'],
  membership: ['Members pay less', 'Ask about membership'],
  'clear pricing': ['Flat pricing, no surprises', 'Prices before you book'],
  concierge: ['Private, unhurried visits'],
  'after-hours': ['Evenings and weekends'],
};

function adsPlan(client, rep, settings) {
  let i1 = {}; try { i1 = JSON.parse(client.intake1_data || '{}'); } catch {}
  const F = (rep && rep.facts) || {};
  const biz = String(client.business_name || i1['Business Name'] || client.name || 'This business').trim();
  const cityFull = String(i1['Primary City & State'] || i1['Location'] || '').trim();
  // the page's own towns beat stale intake data
  const pageCities = (F.cities || []).map((c) => c.name).filter(Boolean);
  const city = (pageCities[0] || cityFull.split(',')[0] || '').trim();
  const V = String(client.vertical || 'iv').toLowerCase();
  const P = VERTICAL_ADS[V] || VERTICAL_ADS.iv;
  const phone = String(client.phone || '').trim();
  const pd = phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  const phoneNice = pd.length === 10 ? '(' + pd.slice(0, 3) + ') ' + pd.slice(3, 6) + '-' + pd.slice(6) : phone;
  const cl = city.toLowerCase();
  const entry = (rep && rep.url) || F.entry || '';

  const ex = (t) => '[' + String(t).toLowerCase().replace(/[^a-z0-9+ ']/g, ' ').replace(/\s+/g, ' ').trim() + ']';
  const ph = (t) => '"' + String(t).toLowerCase().replace(/[^a-z0-9+ ']/g, ' ').replace(/\s+/g, ' ').trim() + '"';
  const withCity = (t, c) => t + ' ' + String(c || cl).toLowerCase();

  const bizLc = biz.toLowerCase();
  const offerings = (F.offerings || []).filter((o) => o.name && o.name.toLowerCase() !== bizLc);
  const memberships = (F.memberships || []).filter((o) => o.name);
  const problems = offerings.filter((o) => PROBLEM_RX.test(o.name));
  const outcomes = offerings.filter((o) => !PROBLEM_RX.test(o.name));
  const derived = offerings.length > 0;

  // ── ad groups: real offerings first, template only as backfill
  const groups = [];
  groups.push({ name: 'Core — ' + P.label, theme: P.label, url: entry,
    keywords: P.core.flatMap((t) => [ex(t), ex(withCity(t))]).concat(P.core.slice(0, 4).map((t) => ph(t))) });
  groups.push({ name: 'At-home / mobile intent', theme: 'delivery model', url: entry,
    keywords: P.intent.flatMap((t) => [ex(t), ph(t)]) });

  const dripTerms = (list) => list.flatMap((o) => {
    const n = o.name.toLowerCase();
    const k = [ex(n), ph(n)];
    if (cl) k.push(ex(withCity(n)));
    if (!/iv|drip|infusion|shot/.test(n)) k.push(ph(n + ' iv'), ph(n + ' drip'));
    return k;
  });
  if (problems.length) {
    groups.push({ name: 'Problem drips — ' + problems.slice(0, 4).map((o) => o.name).join(', '),
      theme: 'why they search today', url: entry,
      keywords: dripTerms(problems).concat(P.problem.flatMap((t) => [ex(t), ph(t)])) });
  } else {
    groups.push({ name: 'Problem and urgency', theme: 'why they search today', url: entry,
      keywords: P.problem.flatMap((t) => [ex(t), ph(t)]) });
  }
  if (outcomes.length) {
    groups.push({ name: 'Named drips — ' + outcomes.slice(0, 4).map((o) => o.name).join(', '),
      theme: 'they already know what they want', url: entry,
      keywords: dripTerms(outcomes) });
  }
  if (memberships.length) {
    const mt = memberships.flatMap((m) => [ex(m.name), ph(m.name + ' membership')]);
    groups.push({ name: 'Membership — ' + memberships.map((m) => m.name).join(', '),
      theme: 'recurring revenue, the cheapest lead you will buy',
      url: entry,
      keywords: mt.concat([ex(P.label + ' membership'), ph(P.label + ' membership'), cl ? ex(P.label + ' membership ' + cl) : ''].filter(Boolean)) });
  }
  // hyper-local ad groups, one per town that has its own landing page
  const cityGroups = (F.cities || []).filter((c) => c.page).slice(0, 5);
  for (const c of cityGroups) {
    const lc = c.name.toLowerCase();
    groups.push({ name: 'City — ' + c.name, theme: 'hyper-local keywords', url: entry,
      keywords: P.core.slice(0, 4).flatMap((t) => [ex(withCity(t, lc)), ph(withCity(t, lc))])
        .concat(problems.slice(0, 3).map((o) => ex(withCity(o.name.toLowerCase(), lc)))) });
  }
  if (!cityGroups.length && cl) {
    groups.push({ name: 'City — ' + city, theme: 'geo-qualified', url: entry,
      keywords: P.core.slice(0, 5).flatMap((t) => [ex(withCity(t)), ph(withCity(t))]) });
  }

  const brandTerms = [ex(biz), ph(biz)].concat(cl ? [ex(biz + ' ' + cl)] : []);

  // ── headlines: the page's own words first
  const pagePool = [];
  const fit = (s) => (s && s.length <= 30 ? s : '');
  for (const o of offerings.slice(0, 8)) {
    if (cl) pagePool.push(fit(o.name + ' in ' + city));
    pagePool.push(fit(o.name));
    if (o.price) pagePool.push(fit(o.name + ', $' + o.price));
  }
  if (F.priceMin) pagePool.push(fit(P.label.replace(/\b\w/, (m) => m.toUpperCase()) + ' from $' + F.priceMin), fit('Drips from $' + F.priceMin));
  if (F.addon) pagePool.push(fit('Add anything, $' + F.addon));
  if (memberships.length) {
    const mp = memberships.map((m) => m.price).filter(Boolean);
    if (mp.length) pagePool.push(fit('Membership from $' + Math.min(...mp)));
    pagePool.push(fit('Members pay less'));
  }
  for (const d of (F.diffs || [])) (DIFF_HEADLINES[d] || []).forEach((h) => pagePool.push(fit(h)));
  for (const t of (F.trust || [])) {
    if (t.k === 'rating') pagePool.push(fit(t.v + ' stars on Google'));
    if (t.k === 'reviews') pagePool.push(fit(t.v + ' local reviews'));
    if (t.k === 'years') pagePool.push(fit(t.v + ' years in ' + (city || 'practice')));
  }
  if (pageCities.length > 1) pagePool.push(fit(pageCities[0] + ' to ' + pageCities[pageCities.length - 1]));

  const cityHeads = fillTpl(P.cityHeads, { c: city, b: biz }).filter((h) => h.length <= 30 && adsPolicyOk(h));
  const brandPool = fillTpl(P.brandHeads, { c: city, b: biz }).filter((h) => h.length <= 30 && adsPolicyOk(h));
  const disq = fillTpl(P.disqualifiers, { c: city, b: biz }).filter((h) => h.length <= 30 && adsPolicyOk(h));
  const pool = cityHeads
    .concat(pagePool.filter(Boolean).filter(adsPolicyOk))
    .concat(brandPool, disq, P.headlines);
  const headlines = pickHeadlines(pool, 15);
  for (const p of cityHeads.slice(0, 2)) if (!headlines.includes(p) && headlines.length) headlines[headlines.length - 1] = p;
  const pinH1 = headlines.filter((h) => cityHeads.includes(h)).slice(0, 3);

  // ── descriptions: weave in real prices, towns and proof where they fit
  const dPool = [];
  if (F.priceMin && city) dPool.push('Drips from $' + F.priceMin + ' in ' + city + '. A licensed nurse comes to you, no clinic visit.');
  if (offerings.length >= 3) dPool.push('Choose from ' + offerings.length + ' drips, or tell us how you feel and we match the bag.');
  if (pageCities.length > 2) dPool.push('We travel across ' + pageCities.slice(0, 3).join(', ') + ' and the towns around them.');
  if (F.addon) dPool.push('Add anything to any drip for $' + F.addon + ', on the same visit, decided with your nurse.');
  const descriptions = dPool.concat(P.descriptions).filter((d) => d.length <= 90 && adsPolicyOk(d)).slice(0, 4);
  const lint = adsLint(headlines, descriptions);
  const econ = adsEconomics(rep && rep.econ, F);

  const plan = {
    v: 3, built: new Date().toISOString(), biz, city: city || cityFull, vertical: P.label,
    url: entry, derived, scannedPages: (F.pages || []).length,
    // Every ad group sends traffic to the GoHighLevel landing page Tiffany built.
    // The client's own website was read to learn WHAT THEY SELL — it is research,
    // not a destination. Ads never point at a website page.
    destination: 'All ad groups → the GoHighLevel landing page. The client website was read for research only.',
    facts: {
      offerings: offerings.map((o) => o.name + (o.price ? ' ($' + o.price + ')' : '')),
      memberships: memberships.map((m) => m.name + (m.price ? ' ($' + m.price + ')' : '')),
      cities: pageCities, diffs: F.diffs || [],
      trust: (F.trust || []).map((t) => t.k + ' ' + t.v),
      priceRange: F.priceMin ? '$' + F.priceMin + '–$' + F.priceMax : '',
      addon: F.addon || 0, booking: F.booking || '',
    },
    campaigns: [
      {
        role: 'non-brand', name: biz + ' — Search — ' + (city || 'Local'),
        settings: {
          'Campaign type': 'Search only',
          'Goal': 'Leads. Do NOT pick "without a goal\'s guidance" — you lose the settings guardrails.',
          'Networks': 'Google Search only. Display Network OFF. Search Partners OFF for lead gen.',
          'Locations': pageCities.length > 1
            ? 'Target these towns by name: ' + pageCities.join(', ') + '. They came off the site, so a landing page already exists for most of them.'
            : (city ? 'Radius 12–20 miles around ' + city : 'Radius around the service area'),
          'Location options': 'Presence — "people in or regularly in your targeted locations". Never leave the presence-or-interest default.',
          'Bidding': 'Maximize Conversions from launch. No target CPA for the first month; then set it AT current performance and move it at most once a fortnight.',
          'Daily budget': econ.daily_budget ? '$' + econ.daily_budget + '/day (back-solved below). Floor to learn anything: $' + (econ.floor_daily || 25) + '/day.'
            : 'Back-solve it: expected CPC × 5 is the floor for ~5–10 clicks a day.',
          'Conversion counting': 'One (lead gen).',
          'Broad match toggle': 'OFF at campaign level. Exact and phrase only until negatives, tracking and profit are proven.',
          'Optimized targeting': 'OFF at launch. Revisit past ~100 conversions.',
          'AI Max': 'OFF. It writes its own ad text, which is disqualifying in a regulated healthcare account.',
          'Auto-apply recommendations': 'OFF — especially "Remove conflicting negative keywords".',
          'Ad schedule': 'Match the hours a human actually answers.',
          'Devices': 'All on. Read the device report after two weeks.',
          'Ad rotation': 'Optimize: prefer best performing ads.',
        },
        adGroups: groups,
      },
      {
        role: 'brand', name: biz + ' — Brand',
        settings: { 'Why': 'Cheap, high-intent, and it stops a competitor buying your name.', 'Daily budget': '$3–$5/day.', 'Bidding': 'Maximize Conversions.' },
        adGroups: [{ name: 'Brand — ' + biz, theme: 'people already looking for you', url: entry, keywords: brandTerms }],
      },
    ],
    negatives: negList(P.negatives),
    rsa: { headlines, pinH1, descriptions, lint,
      pinning: 'Pin the 2–3 keyword/city headlines to position 1 and leave the rest unpinned. Full pinning collapses the combinations; none at all lets Google drop your keyword out of the visible headline.' },
    assets: {
      callouts: (P.callouts || []).filter((s) => s.length <= 25),
      sitelinks: (P.sitelinks || []).filter((s) => s[0].length <= 25 && s[1].length <= 35),
      snippets: { header: 'Services', values: (offerings.length ? offerings.map((o) => o.name) : (P.snippets || [])).filter((s) => s.length <= 25).slice(0, 10) },
      call: phoneNice
        ? 'Call asset: ' + phoneNice + '. Turn ON call reporting so it uses a Google forwarding number. Count each caller once, minimum 60 seconds.'
        : 'Call asset: add the business phone, then turn on call reporting.',
      location: 'Location asset: link the Google Business Profile once it is verified.',
      note: 'A phone number must never appear in headline or description text — that is what the call asset is for.',
    },
    conversions: [
      'Tools → Data manager → link the GA4 property Mission Control created.',
      'Goals → Conversions → Import → Google Analytics 4 → import call_click, sms_click, form_submit, book_click.',
      'Primary: form_submit and book_click. Calls Primary only if they get answered reliably.',
      'Conversion counting: One.',
      'Do not spend a dollar before a real conversion has been recorded end to end.',
    ],
    economics: econ,
    cadence: {
      Daily: 'Nothing. Tweaking daily is itself a failure mode — the bidding needs room to learn.',
      Weekly: 'Search terms report → add negatives, promote winning terms to exact. Reallocate budget. Small copy tweaks.',
      Monthly: 'Bidding review and target adjustment. Full creative refresh. Device, hour and location reports.',
      'First 6 weeks': 'Change one thing at a time. Every change restarts learning.',
    },
    policy: [
      'No outcome or cure claims anywhere in the ad or on the page.',
      'No prescription drug names in ad text.',
      'No phone number in ad text. No exclamation marks. No "#1", "best", "guaranteed".',
      'The page must show a real business name, a working phone number, and privacy plus terms links.',
      'The ad promise and the landing page headline must match, close to word for word.',
    ],
    divergences: [
      'Bidding: Ben Heath says start on conversion-based Smart Bidding from day one; much of the local-PPC world says Maximize Clicks until ~30 conversions exist. This sheet follows Heath. If six weeks pass under 15 conversions, the fix is the offer and the page, not the bid strategy.',
      'Search Partners: Heath leaves them on; current lead-gen opinion leans to opting out. This sheet opts out.',
      'Ad Strength is a completeness checklist, not a target. Never delete a converting asset to chase the rating.',
    ],
  };

  const L = []; const line = (s) => L.push(s);
  line('CAMPAIGN BUILD SHEET v3 — ' + biz + (city ? ' (' + city + ')' : ''));
  line('Landing page: ' + (entry || '(not connected)'));
  line('Built ' + plan.built.slice(0, 10) + (derived ? ' by reading ' + plan.scannedPages + ' page(s) of their own site.' : ' from the vertical library — no offerings were readable on the page.'));
  line('');
  line('LANDING PAGE RULE: every ad group below points at YOUR GoHighLevel page,');
  line('   ' + (entry || '(paste it first)'));
  line('   Their own website was read to learn what they sell. It is research, never an ad destination.');
  line('   Build a second GoHighLevel page for a town or a drip and point that ad group at it instead.');
  line('');
  if (derived) {
    line('0. WHAT WE READ OFF THEIR SITE — research only, but everything below is built from it');
    if (offerings.length) { line('   Offerings (' + offerings.length + '):'); for (const o of offerings) line('      • ' + o.name + (o.price ? '  $' + o.price : '')); }
    if (memberships.length) { line('   Memberships:'); for (const m of memberships) line('      • ' + m.name + (m.price ? '  $' + m.price : '')); }
    if (pageCities.length) line('   Towns they serve: ' + pageCities.join(', '));
    if (F.diffs && F.diffs.length) line('   How they are different: ' + F.diffs.join(' · '));
    if (plan.facts.trust.length) line('   Proof on the page: ' + plan.facts.trust.join(' · '));
    if (plan.facts.priceRange) line('   Price range: ' + plan.facts.priceRange + (F.addon ? '  ·  add-ons $' + F.addon : ''));
    if (F.booking) line('   Booking runs through: ' + F.booking);
    line('');
  }
  line('1. BEFORE YOU BUILD');
  for (const s of plan.conversions) line('   • ' + s);
  line('');
  if (econ.monthly_budget || econ.max_cpl) {
    line('2. THE NUMBERS (from this client\'s own economics)');
    if (econ.ticket) line('   • Average new-client value: $' + econ.ticket + ' at ' + Math.round(econ.margin * 100) + '% margin = $' + econ.gross_per_client + ' gross');
    if (econ.target) line('   • Target ' + econ.target + ' new clients/mo → ' + econ.leads_needed + ' leads needed');
    if (econ.max_cpl) line('   • Most you can pay per lead: $' + econ.max_cpl);
    if (econ.projected_cpl) line('   • Projected cost per lead: $' + econ.projected_cpl);
    if (econ.monthly_budget) line('   • Budget that implies: $' + econ.monthly_budget + '/month (~$' + econ.daily_budget + '/day)');
    if (econ.headroom != null) line('   • Headroom per lead: ' + (econ.headroom >= 0 ? '$' + econ.headroom + ' — the math works' : '-$' + Math.abs(econ.headroom) + ' — the math does NOT work at these numbers'));
    if (econ.required && econ.headroom < 0) {
      line('   • ANY ONE OF THESE CLOSES THE GAP:');
      line('       - a new client is worth $' + econ.required.ticket + ' instead of $' + econ.ticket);
      line('       - the page converts at ' + econ.required.lp_cvr + '% instead of ' + Math.round(econ.lp_cvr * 100) + '%');
      line('       - cost per click comes in at $' + econ.required.cpc + ' instead of $' + econ.cpc);
    }
    line('   • Planning numbers, not promises. Nobody can guarantee ad results.');
    line('');
  }
  let n = 3;
  for (const camp of plan.campaigns) {
    line(n + '. CAMPAIGN — ' + camp.name + '  [' + camp.role + ']');
    for (const [k, v] of Object.entries(camp.settings)) line('   • ' + k + ': ' + v);
    for (const g of camp.adGroups) {
      line('   AD GROUP: ' + g.name);
      if (g.url) line('      final URL → ' + g.url + '   (your GoHighLevel page)');
      line('      ' + g.keywords.join('  '));
    }
    line(''); n++;
  }
  line(n + '. NEGATIVE KEYWORDS — build as a shared list BEFORE you spend (' + plan.negatives.length + ' terms)');
  line('   ' + plan.negatives.join(', '));
  line(''); n++;
  line(n + '. AD COPY — one RSA per ad group');
  line('   PIN TO HEADLINE 1: ' + (plan.rsa.pinH1.join(' | ') || '(none — add a city)'));
  line('   ' + plan.rsa.pinning);
  line('   HEADLINES (' + headlines.length + ', ≤30 characters, sentence case on purpose):');
  for (const h of headlines) line('      • ' + h + '   [' + h.length + ']');
  line('   DESCRIPTIONS (' + descriptions.length + ', 61–80 beats maxing 90):');
  for (const d of descriptions) line('      • ' + d + '   [' + d.length + ']');
  if (lint.issues.length) { line('   LINT:'); for (const s of lint.issues) line('      ! ' + s); }
  line(''); n++;
  line(n + '. ASSETS');
  line('   • ' + plan.assets.call);
  line('   • ' + plan.assets.location);
  line('   • Callouts: ' + plan.assets.callouts.join(' · '));
  line('   • Structured snippet — Services: ' + plan.assets.snippets.values.join(', '));
  for (const s of plan.assets.sitelinks) line('   • Sitelink: ' + s[0] + ' — ' + s[1]);
  line('   • ' + plan.assets.note);
  line(''); n++;
  line(n + '. AFTER LAUNCH');
  for (const [k, v] of Object.entries(plan.cadence)) line('   • ' + k + ': ' + v);
  line(''); n++;
  line(n + '. POLICY GUARDRAILS');
  for (const s of plan.policy) line('   • ' + s);
  line(''); n++;
  line(n + '. WHERE THE EXPERTS DISAGREE');
  for (const s of plan.divergences) line('   • ' + s);
  plan.text = L.join('\n');
  return plan;
}

function adsBrief(client, rep) { return adsPlan(client, rep, null); }

// Deep links that drop her exactly where she needs to be in Google's UI.
function adsDeepLinks(rep, settings) {
  const cid = String(rep.ads_cid || '').replace(/\D/g, '');
  const mcc = String((settings && settings.ads_mcc_id) || '').replace(/\D/g, '');
  const q = cid ? '?__c=' + cid : '';
  return {
    cid,
    account: rep.ads_url || (cid ? 'https://ads.google.com/aw/overview' + q : 'https://ads.google.com/nav/selectaccount'),
    newCampaign: cid ? 'https://ads.google.com/aw/campaigns/new' + q : '',
    campaigns: cid ? 'https://ads.google.com/aw/campaigns' + q : '',
    conversions: cid ? 'https://ads.google.com/aw/conversions' + q : '',
    linkGa4: cid ? 'https://ads.google.com/aw/linkedaccounts' + q : '',
    createAccount: mcc ? 'https://ads.google.com/aw/accountmanagement?__c=' + mcc : 'https://ads.google.com/nav/selectaccount',
    ga4: rep.ga4_property ? 'https://analytics.google.com/analytics/web/#/p' + rep.ga4_property + '/reports/intelligenthome' : 'https://analytics.google.com/',
    clarity: rep.clarity_id ? 'https://clarity.microsoft.com/projects/view/' + rep.clarity_id + '/dashboard' : 'https://clarity.microsoft.com/',
  };
}

// THE ONE PASTE. Body: { url, track? }.
app.post('/api/clients/:id/ads-provision', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'no such client' }, 404);
  let body = {}; try { body = await c.req.json(); } catch {}
  let settings = await getSettings(db);
  let rep = {}; try { rep = JSON.parse(settings['ads_' + id] || '{}'); } catch {}

  let url = String(body.url || rep.url || '').trim();
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { return c.json({ error: 'Paste the full landing page URL (the GoHighLevel funnel link).' }, 400); }

  // 1 — verify the page
  const report = await adsVerify(c.env, id, url);
  rep = { ...rep, ...report, url };
  if (!rep.track) { rep.track = String(body.track || 'addon'); rep.monthly = 249; rep.enrolled_at = rep.enrolled_at || new Date().toISOString(); }

  // 1b — ZERO TOUCH: if the GoHighLevel page already carries tags, adopt those
  // IDs instead of asking her for them or creating a second property. Anything
  // already saved wins, so this can never overwrite a deliberate choice.
  const adopted = [];
  const detGa4 = (report.checks && report.checks.ga4 && report.checks.ga4.id) || '';
  const detClar = (report.checks && report.checks.clarity && report.checks.clarity.id) || '';
  const detGtm = (report.checks && report.checks.gtm && report.checks.gtm.id) || '';
  if (detGa4 && !rep.ga4_measurement) { rep.ga4_measurement = String(detGa4).toUpperCase(); adopted.push('Google Analytics ' + rep.ga4_measurement); }
  if (detClar && !rep.clarity_id) { rep.clarity_id = String(detClar); adopted.push('Clarity ' + rep.clarity_id); }
  if (detGtm && !rep.gtm_id) { rep.gtm_id = String(detGtm).toUpperCase(); adopted.push('Tag Manager ' + rep.gtm_id); }
  await setSetting(db, 'ads_' + id, JSON.stringify(rep));

  // 2 — GA4 property + key events (idempotent; safe to call every paste)
  const ga4 = await ga4Ensure(c.env, id);
  settings = await getSettings(db);
  try { rep = JSON.parse(settings['ads_' + id] || '{}'); } catch {}

  // 2b — Search Console: if this domain is already verified on her Google
  // account, wire it now so the rankings snapshots start on their own.
  let gscAttached = '';
  try {
    let host = ''; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
    let stG = {}; try { stG = JSON.parse(settings['gsc_' + id] || '{}'); } catch {}
    if (host && !/workers\.dev$/.test(host) && (!stG || !stG.property) && gscConfigured(c.env)) {
      const props = await gscListProperties(c.env).catch(() => null);
      const list = (props && (props.siteEntry || props.sites || props)) || [];
      const hit = (Array.isArray(list) ? list : []).find((p) => {
        const site = String((p && (p.siteUrl || p.site)) || '');
        return site.replace(/^sc-domain:|^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '') === host
          && /Owner|FullUser|Restricted/i.test(String((p && (p.permissionLevel || p.permission)) || ''));
      });
      if (hit) {
        await setSetting(db, 'gsc_' + id, JSON.stringify({ ...(stG || {}), property: host, verified: 'auto' }));
        gscAttached = host;
        c.executionCtx.waitUntil(gscRankSnapshot(c.env).catch(() => {}));
      }
    }
  } catch {}

  // 3 — portal analytics card ON for this client
  rep.portal_analytics = rep.portal_analytics === false ? false : true;

  // 3b — READ THE PAGE. Crawl the landing page and the menu/pricing/membership
  // /city pages it links to, and pull out what they actually sell. The plan is
  // then built from their real offerings, prices and towns, not a template.
  try {
    const facts = await adsScan(c.env, id, url);
    if (facts && !facts.error) rep.facts = facts;
  } catch {}

  // 4 — the build sheet she works from
  rep.brief = adsPlan(client, rep, settings);
  rep.provisioned_at = new Date().toISOString();
  await setSetting(db, 'ads_' + id, JSON.stringify(rep));

  const links = adsDeepLinks(rep, settings);
  const lights = ['ga4', 'clarity', 'phone', 'form', 'policy', 'tracker']
    .map((k) => (report.checks[k] && report.checks[k].ok ? '✓' : '✗') + k).join(' ');
  await logEvent(db, id, 'ads_provisioned',
    `\u{1F4E3} Ads provision on ${url} — ${lights}${ga4.measurement ? ' · GA4 ' + ga4.measurement : ''}${ga4.pending ? ' · GA4 pending (' + ga4.pending + ')' : ''}${adopted.length ? ' · adopted ' + adopted.join(', ') : ''}${gscAttached ? ' · Search Console ' + gscAttached : ''}${rep.facts ? ' · read ' + rep.facts.offerings.length + ' offering(s) and ' + (rep.facts.cities || []).length + ' town(s) off ' + (rep.facts.pages || []).length + ' page(s)' : ''}. Build sheet ready; campaign is Tiffany's to build in Google Ads.`);

  const steps = [
    { k: 'snippet', done: !!(report.checks.tracker && report.checks.tracker.ok),
      label: 'Tracking snippet on the page', detail: `<script defer src="${BASE_URL}/t/${id}/t.js"></script> in the GHL funnel head` },
    { k: 'ga4', done: !!(rep.ga4_measurement), label: 'Google Analytics property', detail: rep.ga4_measurement || (ga4.pending ? 'pending: ' + ga4.pending : 'not created') },
    { k: 'events', done: !!(rep.ga4_measurement), label: 'Key events registered', detail: 'call_click · sms_click · form_submit · book_click' },
    { k: 'portal', done: true, label: 'Client portal analytics card', detail: 'live on their portal now' },
    { k: 'account', done: !!links.cid, label: 'Google Ads account linked', detail: links.cid ? links.cid : 'paste the 10-digit customer ID in the Ads tab' },
    { k: 'brief', done: true, label: 'Campaign build sheet', detail: ((rep.brief && rep.brief.rsa && rep.brief.rsa.headlines.length) || 0) + ' headlines · ' +
      ((rep.brief && rep.brief.campaigns) || []).reduce((a, x) => a + x.adGroups.length, 0) + ' ad groups · ' + ((rep.brief && rep.brief.negatives) || []).length + ' negatives' },
    { k: 'campaign', done: !!rep.live_at, label: 'Campaign built + enabled (yours)', detail: 'Mission Control never enables spend' },
  ];
  return c.json({ ok: true, report: rep, ga4, links, steps, brief: rep.brief, adopted, gsc: gscAttached });
});

// ════════════════════════════════════════════════════════════════════════════
// ⬇ CAMPAIGN CSV (8/19/2026) — the biggest automation available without the
// Google Ads API. Instead of typing the build sheet into Google Ads by hand for
// an hour, she downloads two files, imports them into Google Ads Editor, and
// the entire campaign exists — paused — in about a minute.
//
// Route and format are per Google's own docs (support.google.com/google-ads/
// editor/answer/57747 and /56368):
//   • Google Ads Editor infers the entity type of each row from WHICH identity
//     columns are populated. Campaign only = campaign settings. Campaign +
//     Location = a location target. Campaign + Keyword with Criterion type
//     "Campaign negative" = a campaign negative. Campaign + Ad group = ad group
//     settings. Campaign + Ad group + Keyword = a keyword. Campaign + Ad group
//     + Headline 1 = a responsive search ad.
//   • Headers are matched case- and space-insensitively.
//   • Pinning is expressed as "Headline N position" = 1, 2 or 3.
//
// TWO FILES ON PURPOSE. Editor has no "Ad type" column, so an RSA row in a
// mixed file is identified only by Headline 1 being populated. Google's own
// documented path for bulk RSAs is the Responsive search ads view → Make
// multiple changes → paste. Splitting the files follows Google's grain instead
// of betting her account on an undocumented inference.
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvRows(header, rows) {
  return [header.map(csvCell).join(',')]
    .concat(rows.map((r) => header.map((h) => csvCell(r[h] === undefined ? '' : r[h])).join(',')))
    .join('\r\n') + '\r\n';
}
// keywords are stored as [exact] and "phrase" — Editor wants the bare text plus
// a Criterion type column, so unwrap them here rather than shipping the brackets
function csvKeyword(k) {
  const s = String(k || '').trim();
  if (s.startsWith('[') && s.endsWith(']')) return { text: s.slice(1, -1).trim(), type: 'Exact' };
  if (s.startsWith('"') && s.endsWith('"')) return { text: s.slice(1, -1).trim(), type: 'Phrase' };
  return { text: s, type: 'Broad' };
}

function adsCsvStructure(plan, opts) {
  const O = opts || {};
  const budget = Number(O.budget) || 30;
  const start = O.start || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const H = ['Campaign', 'Campaign type', 'Campaign status', 'Campaign daily budget', 'Bid strategy type',
    'Networks', 'Languages', 'Start date', 'Location', 'Ad group', 'Ad group status', 'Keyword',
    'Criterion type', 'Status'];
  const rows = [];
  const nonBrand = plan.campaigns.find((c) => c.role === 'non-brand');
  const brand = plan.campaigns.find((c) => c.role === 'brand');

  for (const camp of [nonBrand, brand].filter(Boolean)) {
    const isBrand = camp.role === 'brand';
    rows.push({
      Campaign: camp.name, 'Campaign type': 'Search', 'Campaign status': 'Paused',
      'Campaign daily budget': (isBrand ? Math.max(3, Math.round(budget * 0.1)) : budget).toFixed(2),
      'Bid strategy type': 'Maximize conversions', Networks: 'Google Search', Languages: 'en',
      'Start date': start,
    });
    // locations — names, not IDs. Editor flags anything it cannot resolve with a
    // yellow warning and makes her confirm, which is the safe failure here.
    for (const loc of (O.locations || [])) rows.push({ Campaign: camp.name, Location: loc });
    // negatives ride the non-brand campaign only. Putting "free" or "cheap" on a
    // brand campaign would block people searching the business by name.
    if (!isBrand) {
      for (const n of (plan.negatives || [])) {
        rows.push({ Campaign: camp.name, Keyword: n, 'Criterion type': 'Campaign negative' });
      }
    }
    for (const g of camp.adGroups) {
      rows.push({ Campaign: camp.name, 'Ad group': g.name, 'Ad group status': 'Enabled' });
      const seen = new Set();
      for (const k of g.keywords) {
        const kw = csvKeyword(k);
        if (!kw.text) continue;
        const key = kw.text + '|' + kw.type;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ Campaign: camp.name, 'Ad group': g.name, Keyword: kw.text,
          'Criterion type': kw.type, Status: 'Enabled' });
      }
    }
  }
  return csvRows(H, rows);
}

function adsCsvAds(plan, opts) {
  const O = opts || {};
  const H = ['Campaign', 'Ad group'];
  for (let i = 1; i <= 15; i++) H.push('Headline ' + i);
  for (let i = 1; i <= 3; i++) H.push('Headline ' + i + ' position');
  for (let i = 1; i <= 4; i++) H.push('Description ' + i);
  H.push('Final URL', 'Path 1', 'Path 2', 'Status');
  const rows = [];
  const heads = plan.rsa.headlines || [];
  const descs = plan.rsa.descriptions || [];
  const pins = plan.rsa.pinH1 || [];
  const path1 = String(O.path1 || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 15);

  for (const camp of plan.campaigns) {
    for (const g of camp.adGroups) {
      // lead with a headline that names THIS ad group's theme, pinned to slot 1,
      // so the ad always echoes the search that triggered it
      const themeHead = heads.find((h) => {
        const n = g.name.toLowerCase();
        return n.includes(h.toLowerCase().split(' in ')[0].toLowerCase()) ||
          h.toLowerCase().includes(n.replace(/^city — |^named drips — |^problem drips — |^core — /, '').split(',')[0].toLowerCase());
      });
      const ordered = [];
      if (themeHead) ordered.push(themeHead);
      for (const p of pins) if (!ordered.includes(p)) ordered.push(p);
      for (const h of heads) if (!ordered.includes(h)) ordered.push(h);
      const row = { Campaign: camp.name, 'Ad group': g.name, 'Final URL': g.url || plan.url,
        'Path 1': path1, Status: 'Enabled' };
      ordered.slice(0, 15).forEach((h, i) => { row['Headline ' + (i + 1)] = h; });
      // pin only the first slot; over-pinning collapses the combinations Google
      // is supposed to be testing
      row['Headline 1 position'] = 1;
      descs.slice(0, 4).forEach((d, i) => { row['Description ' + (i + 1)] = d; });
      rows.push(row);
    }
  }
  return csvRows(H, rows);
}

// GET ?part=structure|ads — returns a downloadable CSV for Google Ads Editor.
app.get('/api/clients/:id/ads-csv', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'no such client' }, 404);
  const settings = await getSettings(db);
  let rep = {}; try { rep = JSON.parse(settings['ads_' + id] || '{}'); } catch {}
  if (!rep.url) return c.json({ error: 'Connect the landing page first.' }, 400);
  const plan = rep.brief && rep.brief.v === 3 ? rep.brief : adsPlan(client, rep, settings);
  const econ = adsEconomics(rep.econ, rep.facts);
  const F = rep.facts || {};
  let i1 = {}; try { i1 = JSON.parse(client.intake1_data || '{}'); } catch {}
  const state = String(i1['Primary City & State'] || i1['Location'] || '').split(',')[1] || '';
  const locs = ((F.cities || []).map((x) => x.name).filter(Boolean).slice(0, 12))
    .map((n) => (state ? n + ',' + state.trim() + ',United States' : n));
  const opts = {
    budget: econ.daily_budget || econ.floor_daily || 30,
    locations: locs.length ? locs : (plan.city ? [plan.city] : []),
    path1: (plan.city || '').replace(/\s+/g, '-'),
  };
  const part = String(c.req.query('part') || 'structure');
  const body = part === 'ads' ? adsCsvAds(plan, opts) : adsCsvStructure(plan, opts);
  const safe = String(client.business_name || client.name || ('client-' + id)).replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40);
  const name = safe + (part === 'ads' ? '-2-ads.csv' : '-1-structure.csv');
  if (part === 'ads') {
    await logEvent(db, id, 'ads_csv',
      `\u{2B07} Campaign CSV downloaded for ${client.business_name || client.name || client.email} — ` +
      `${plan.campaigns.reduce((a, x) => a + x.adGroups.length, 0)} ad groups, ${plan.negatives.length} negatives, ` +
      `budget $${opts.budget}/day. Import into Google Ads Editor; it lands PAUSED.`);
  }
  return c.body(body, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="' + name + '"',
  });
});

// 🔬 RESCAN — she changed the page (new drip, new member benefit, new town).
// Re-reads the site and rebuilds the whole plan around what is there now.
app.post('/api/clients/:id/ads-rescan', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'no such client' }, 404);
  const settings = await getSettings(db);
  let rep = {}; try { rep = JSON.parse(settings['ads_' + id] || '{}'); } catch {}
  let body = {}; try { body = await c.req.json(); } catch {}
  let url = String(body.url || rep.url || '').trim();
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (!url) return c.json({ error: 'Connect the landing page first.' }, 400);
  const before = ((rep.facts && rep.facts.offerings) || []).map((o) => o.name).join('|');
  const facts = await adsScan(c.env, id, url);
  if (!facts || facts.error) return c.json({ error: (facts && facts.error) || 'could not read the page' }, 502);
  rep.url = url; rep.facts = facts;
  rep.brief = adsPlan(client, rep, settings);
  await setSetting(db, 'ads_' + id, JSON.stringify(rep));
  const after = facts.offerings.map((o) => o.name).join('|');
  const changed = before !== after;
  await logEvent(db, id, 'ads_rescan',
    `\u{1F52C} Re-read ${(facts.pages || []).length} page(s) for ${client.business_name || client.name || client.email} — ` +
    `${facts.offerings.length} offering(s), ${(facts.memberships || []).length} membership tier(s), ${(facts.cities || []).length} town(s). ` +
    (changed ? 'The menu CHANGED — keywords and headlines rebuilt around it.' : 'Nothing new on the page; the plan was refreshed anyway.'));
  return c.json({ ok: true, facts, brief: rep.brief, changed });
});

// Re-read (or regenerate) the build sheet without re-verifying the page.
app.get('/api/clients/:id/ads-brief', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'no such client' }, 404);
  const settings = await getSettings(db);
  let rep = {}; try { rep = JSON.parse(settings['ads_' + id] || '{}'); } catch {}
  const fresh = c.req.query('fresh') === '1';
  if (fresh || !rep.brief) { rep.brief = adsBrief(client, rep); await setSetting(db, 'ads_' + id, JSON.stringify(rep)); }
  return c.json({ ok: true, brief: rep.brief, links: adsDeepLinks(rep, settings) });
});

// Session-gated alias of the scope probe so the dashboard can show the four
// Google powers at a glance without the shared key ever touching the browser.
app.get('/api/google-health', async (c) => {
  const url = new URL(c.req.url);
  url.pathname = '/api/google-scopes/gen-4b8e1d7f3a';
  url.search = '';
  const r = await app.fetch(new Request(url.toString(), { method: 'GET' }), c.env, c.executionCtx);
  return new Response(r.body, r);
});

// 🧭 LAUNCH RUNBOOK (8/19/2026) — the one-day-per-client sequence, computed
// from real state rather than ticked by hand. Twelve steps from "they said yes"
// to "the campaign is running", each one either already true in the data or
// waiting on a named action. The Ads row shows only the NEXT step, so the
// answer to "what do I do now" is always one line, never a hunt.
// Two steps cannot be detected (conversions imported, campaign built) — those
// are hers to tick, and they are the two that happen inside Google's UI.
function adsRunbook(client, rep, settings, id) {
  const gsc = (() => { try { return JSON.parse(settings['gsc_' + id] || '{}'); } catch { return {}; } })();
  const ck = rep.checks || {};
  const manual = rep.steps || {};
  const steps = [
    { k: 'enrolled', label: 'On the ads track', done: !!rep.track,
      why: 'Puts them on the Ads board and starts the $249/mo clock.',
      todo: 'Open their card and press "Add ads" or "Ads only".' },
    { k: 'economics', label: 'Economics entered', done: !!(rep.econ && rep.econ.target_clients),
      why: 'Without it you are guessing at budget and cannot tell a client what is realistic.',
      todo: 'Press Economics and enter their average ticket, close rate and target.' },
    { k: 'page', label: 'Landing page connected', done: !!rep.url,
      why: 'Everything downstream keys off this URL.',
      todo: 'Paste the GoHighLevel funnel link and press Set it all up.' },
    { k: 'snippet', label: 'Tracking code live on the page', done: !!(ck.tracker && ck.tracker.ok),
      why: 'No tag, no data. Every number in this system starts here.',
      todo: 'Press Head code, copy Option A, paste it into the GHL funnel head, save, then Re-check.' },
    { k: 'ga4', label: 'Google Analytics property', done: !!rep.ga4_measurement,
      why: 'The client-facing numbers and the conversions Google Ads bids on both come from here.',
      todo: 'Set it all up creates it. If it came back pending, create it by hand and paste the G- ID under IDs.' },
    { k: 'events', label: 'Key events firing', done: !!(rep.ga4_measurement && ck.tracker && ck.tracker.ok),
      why: 'call_click, sms_click, form_submit and book_click are what a conversion actually is here.',
      todo: 'Both the property and the snippet have to be in place; then load the page once and Re-check.' },
    { k: 'clarity', label: 'Clarity session replay', done: !!rep.clarity_id, optional: true,
      why: 'Watching ten real sessions explains a bad conversion rate faster than any report.',
      todo: 'clarity.microsoft.com → new project → paste the ID under Head code.' },
    { k: 'gsc', label: 'Search Console attached', done: !!(gsc && gsc.property), optional: true,
      why: 'Free rankings data, and it feeds the portal rankings card.',
      todo: 'Verify the domain in Search Console; Set it all up attaches it automatically after that.' },
    { k: 'account', label: 'Google Ads account linked', done: !!rep.ads_cid || !!rep.ads_url,
      why: 'Without the customer ID every deep link in here points at an account picker instead of their account.',
      todo: 'Create the account under your manager account, then paste the 10-digit ID.' },
    { k: 'conversions', label: 'Conversions imported into Google Ads', done: !!manual.conversions,
      why: 'THE one that quietly ruins accounts. Bidding on no conversion data burns budget at full speed.',
      todo: 'Tools → Data manager → link GA4 → Goals → Conversions → Import the four key events. Then tick this.',
      tick: true },
    { k: 'campaign', label: 'Campaign built (still paused)', done: !!manual.campaign,
      why: 'Yours to build. The build sheet has every setting, keyword, negative and headline.',
      todo: 'Open Build sheet, then build it in Google Ads and leave it paused. Then tick this.',
      tick: true },
    { k: 'billing', label: rep.lp_fee ? ('Billing — $' + rep.lp_fee + ' landing page + $249/mo') : 'Ads management billing', done: rep.sub_status === 'active',
      why: 'Neither the landing page fee nor the $249/mo invoices itself.',
      todo: rep.sub_link ? 'Link is created — send it to the client.' : 'Press $249/mo billing to create the link.' },
    { k: 'live', label: 'Campaign enabled', done: !!rep.live_at,
      why: 'The moment spend starts, the daily silent-failure check starts watching this client.',
      todo: 'Enable it in Google Ads yourself, then press "I enabled it" here.' },
  ];
  const required = steps.filter((x) => !x.optional);
  const doneN = required.filter((x) => x.done).length;
  const next = steps.find((x) => !x.done && !x.optional) || steps.find((x) => !x.done) || null;
  return { steps, done: doneN, total: required.length, next, ready: doneN === required.length };
}

app.get('/api/clients/:id/ads-runbook', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'no such client' }, 404);
  const settings = await getSettings(db);
  let rep = {}; try { rep = JSON.parse(settings['ads_' + id] || '{}'); } catch {}
  return c.json({ ok: true, biz: client.business_name || client.name || client.email, ...adsRunbook(client, rep, settings, id) });
});

// The two steps that happen inside Google's UI and cannot be detected from here.
app.post('/api/clients/:id/ads-step', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'no such client' }, 404);
  let body = {}; try { body = await c.req.json(); } catch {}
  const key = String(body.key || '');
  if (!['conversions', 'campaign'].includes(key)) return c.json({ error: 'that step is detected automatically, not ticked' }, 400);
  const settings = await getSettings(db);
  let rep = {}; try { rep = JSON.parse(settings['ads_' + id] || '{}'); } catch {}
  rep.steps = rep.steps || {};
  const on = body.done !== false;
  if (on) rep.steps[key] = new Date().toISOString(); else delete rep.steps[key];
  await setSetting(db, 'ads_' + id, JSON.stringify(rep));
  const LABEL = { conversions: 'Conversions imported into Google Ads', campaign: 'Campaign built (still paused)' };
  await logEvent(db, id, 'ads_step', `\u{1F9ED} ${LABEL[key]} — marked ${on ? 'done' : 'not done'} for ${client.business_name || client.name || client.email}`);
  return c.json({ ok: true, ...adsRunbook(client, rep, settings, id) });
});

// 📬 WEEKLY ADS REPORT TO THE CLIENT (8/19/2026, Mondays) — the single
// highest-leverage thing for Tiffany's calendar. Clients who get a clear,
// honest weekly number stop emailing to ask how it is going. Every figure here
// comes from Google Analytics and from the beacon on their own page — nothing
// is estimated, nothing is rounded up, and there is never a promise in it.
async function adsWeeklyClientReport(env) {
  const db = env.DB;
  const settings = await getSettings(db);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) return 0;
  let token = '';
  try {
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' }),
    });
    token = (await tr.json()).access_token || '';
  } catch {}
  if (!token) return 0;
  let sent = 0;
  for (const k of Object.keys(settings).filter((x) => /^ads_\d+$/.test(x))) {
    let rep = {}; try { rep = JSON.parse(settings[k] || '{}'); } catch {}
    if (!rep.live_at || !rep.ga4_property) continue;
    const id = Number(k.slice(4));
    const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
    if (!client || !client.email) continue;
    try {
      const q = async (start) => {
        const rr = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(rep.ga4_property)}:runReport`, {
          method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ dateRanges: [{ startDate: start, endDate: 'today' }], metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'keyEvents' }] }),
        });
        if (!rr.ok) return null;
        const d = await rr.json();
        const m = (d.rows && d.rows[0] && d.rows[0].metricValues) || [];
        return { sessions: Number((m[0] || {}).value || 0), users: Number((m[1] || {}).value || 0), events: Number((m[2] || {}).value || 0) };
      };
      const wk = await q('7daysAgo');
      if (!wk) continue;
      // our own beacon gives the breakdown Google does not split out by default
      const rows = (await db.prepare(
        `SELECT path, SUM(n) AS n FROM hits WHERE slug = ? AND day > date('now','-7 days') GROUP BY path`
      ).bind('ext-' + id).all()).results || [];
      const ev = { call_click: 0, sms_click: 0, form_submit: 0, book_click: 0 };
      for (const r of rows) { const p = String(r.path || ''); if (p.indexOf('ev-') === 0) { const key = p.slice(3); if (key in ev) ev[key] += Number(r.n) || 0; } }
      const total = ev.call_click + ev.sms_click + ev.form_submit + ev.book_click;
      const biz = client.business_name || client.name || 'your business';
      const tok = await portalToken(env, 'portal', id);
      const tile = (n, l) => `<td style="padding:12px 16px;border:1px solid #E6E9EF;border-radius:10px;text-align:center"><div style="font-size:30px;font-family:Georgia,serif;line-height:1">${n}</div><div style="font-size:12px;color:#5D6B7E;margin-top:2px">${l}</div></td>`;
      const html =
        `<p>Here is last week on your landing page, ${client.name ? String(client.name).split(' ')[0] : 'there'} — straight from Google, nothing rounded.</p>` +
        `<table cellspacing="8" cellpadding="0" style="border-collapse:separate"><tr>` +
        tile(wk.users.toLocaleString(), 'people visited') + tile(ev.call_click, 'tapped to call') +
        tile(ev.form_submit, 'sent a form') + tile(ev.book_click, 'started a booking') + `</tr></table>` +
        (total === 0
          ? `<p>No one reached out this week. That happens in a slow week and it is also the kind of thing we watch closely — we check the tracking and the page every single day, and we will tell you before you have to ask.</p>`
          : `<p><b>${total}</b> ${total === 1 ? 'person' : 'people'} reached out to you this week. Every one of them is in your portal with the time it came in.</p>`) +
        `<p>The fastest thing that moves this number is how quickly those people get a reply. Minutes beats hours by a wide margin.</p>` +
        `<p><a href="${BASE_URL}/portal/${id}/${tok}" style="display:inline-block;background:#0B1D33;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none">Open your portal</a></p>` +
        `<p style="font-size:12px;color:#8A94A6">Numbers come from your own Google Analytics property and the tracking on your page. Ad results move week to week — we report what happened, not what we hope for.</p>`;
      const ok = await emailClient(env, db, client, settings, `Your week: ${total} ${total === 1 ? 'enquiry' : 'enquiries'} — ${biz}`, html,
        'ads_report_sent', `📬 Weekly ads report emailed to ${client.email} — ${wk.users} visitors, ${total} enquiries`);
      if (ok) sent++;
    } catch {}
  }
  return sent;
}

// 💳 ADS SUBSCRIPTION (8/19/2026) — $249/mo Google Ads management, billed the
// same way as everything else in this business. Built as a self-contained
// Stripe Checkout call (subscription mode, inline price_data) so it does not
// collide with the single hosting/care subscription each client already has:
// ads billing lives in settings ads_<id>, website billing stays in clients.billing.
// Tiffany sends the link; the client enters their own card on Stripe's page.
// Nothing here ever touches a card number.
const ADS_MONTHLY_CENTS = 24900;

async function adsCheckout(env, client, rep) {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set on the worker');
  const cust = await ensureCustomer(env.STRIPE_SECRET_KEY, client.email, client.name || client.business_name || '');
  const biz = client.business_name || client.name || client.email;
  const back = client.live_url || (rep && rep.url) || BASE_URL;
  const body = new URLSearchParams();
  body.set('mode', 'subscription');
  body.set('customer', cust.id);
  body.set('success_url', back);
  body.set('cancel_url', back);
  body.set('allow_promotion_codes', 'true');
  body.set('line_items[0][quantity]', '1');
  body.set('line_items[0][price_data][currency]', 'usd');
  body.set('line_items[0][price_data][unit_amount]', String(ADS_MONTHLY_CENTS));
  body.set('line_items[0][price_data][recurring][interval]', 'month');
  body.set('line_items[0][price_data][product_data][name]', ('Google Ads management — ' + biz).slice(0, 250));
  body.set('line_items[0][price_data][product_data][description]',
    'Monthly management of your Google Ads account: campaign build and upkeep, keyword and negative maintenance, conversion tracking, and reporting in your client portal. Ad spend is paid separately by you, directly to Google.');
  // the one-time landing page fee rides the same checkout, so the client enters
  // their card once and gets $300 today plus $249 every month after
  const setup = Number((rep && rep.lp_fee) || 0);
  if (setup > 0) {
    body.set('line_items[1][quantity]', '1');
    body.set('line_items[1][price_data][currency]', 'usd');
    body.set('line_items[1][price_data][unit_amount]', String(Math.round(setup * 100)));
    body.set('line_items[1][price_data][product_data][name]', ('Google Ads landing page — ' + biz).slice(0, 250));
    body.set('line_items[1][price_data][product_data][description]',
      'One-time build of the landing page your ads send traffic to, including the tracking that measures calls, texts, forms and bookings, and one round of revisions.');
  }
  body.set('subscription_data[metadata][client_id]', String(client.id));
  body.set('subscription_data[metadata][plan]', 'ads249');
  body.set('metadata[client_id]', String(client.id));
  body.set('metadata[plan]', 'ads249');
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error((j.error && j.error.message) || ('Stripe ' + res.status));
  return { id: j.id, url: j.url, customer: cust.id };
}

app.post('/api/clients/:id/ads-subscription', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'no such client' }, 404);
  if (!client.email) return c.json({ error: 'This client has no email address on file yet.' }, 400);
  const settings = await getSettings(db);
  let rep = {}; try { rep = JSON.parse(settings['ads_' + id] || '{}'); } catch {}
  if (!rep.track) return c.json({ error: 'Enrol them in ads management first.' }, 400);
  try {
    const sess = await adsCheckout(c.env, client, rep);
    rep.sub_session_id = sess.id; rep.sub_link = sess.url; rep.sub_status = 'pending';
    rep.sub_customer = sess.customer; rep.sub_amount = ADS_MONTHLY_CENTS / 100;
    rep.sub_setup = Number(rep.lp_fee || 0);
    await setSetting(db, 'ads_' + id, JSON.stringify(rep));
    await logEvent(db, id, 'ads_billing_link',
      `\u{1F4B3} Ads billing link created for ${client.business_name || client.name || client.email} — ` +
      (rep.lp_fee ? `$${rep.lp_fee} landing page today + $249/mo after. ` : '$249/mo. ') +
      'Send it to them; they enter their own card on Stripe.');
    return c.json({ ok: true, url: sess.url });
  } catch (e) { return c.json({ error: 'Stripe: ' + String(e.message).slice(0, 160) }, 502); }
});

// 📧 SEND THE BILLING LINK — one press instead of copy, switch to email, paste.
app.post('/api/clients/:id/ads-billing-send', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'no such client' }, 404);
  if (!client.email) return c.json({ error: 'No email address on file for this client.' }, 400);
  const settings = await getSettings(db);
  let rep = {}; try { rep = JSON.parse(settings['ads_' + id] || '{}'); } catch {}
  if (!rep.sub_link) return c.json({ error: 'Create the billing link first.' }, 400);
  const biz = client.business_name || client.name || 'your business';
  const first = String(client.name || '').split(' ')[0] || 'there';
  const setup = Number(rep.lp_fee || 0);
  const html =
    `<p>Hi ${first},</p>` +
    `<p>Here is the secure link to start your Google Ads management for <b>${biz}</b>.</p>` +
    `<p>` + (setup
      ? `It sets up <b>$${setup} today</b> for your landing page, then <b>$249 a month</b> for management.`
      : `It sets up <b>$249 a month</b> for management.`) +
    ` Your advertising budget is separate and is paid by you directly to Google — we never hold or bill your ad spend.</p>` +
    `<p><a href="${rep.sub_link}" style="display:inline-block;background:#0B1D33;color:#fff;padding:13px 24px;border-radius:8px;text-decoration:none">Set up your billing</a></p>` +
    `<p style="font-size:13px;color:#5D6B7E">You enter your card on Stripe's own page — we never see it. Month to month, cancel any time with 30 days' notice.</p>` +
    `<p>Once that is done I will build your campaign and walk you through it before anything goes live.</p>` +
    `<p>— Tiffany, ConversionCo</p>`;
  const ok = await emailClient(c.env, db, client, settings,
    `Your Google Ads setup — ${biz}`, html, 'ads_billing_sent',
    `\u{1F4E7} Ads billing link emailed to ${client.email}` + (setup ? ` — $${setup} + $249/mo` : ' — $249/mo'));
  if (!ok) return c.json({ error: 'Email did not send — check the GoHighLevel connection.' }, 502);
  rep.sub_sent_at = new Date().toISOString();
  await setSetting(db, 'ads_' + id, JSON.stringify(rep));
  return c.json({ ok: true, to: client.email });
});

// Landing-page fee toggle — normally set from Intake 1, editable here.
app.post('/api/clients/:id/ads-lp-fee', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'no such client' }, 404);
  let body = {}; try { body = await c.req.json(); } catch {}
  const settings = await getSettings(db);
  let rep = {}; try { rep = JSON.parse(settings['ads_' + id] || '{}'); } catch {}
  const fee = Number(body.fee);
  if (Number.isFinite(fee) && fee > 0) rep.lp_fee = Math.round(fee); else delete rep.lp_fee;
  if (rep.sub_status !== 'active') { delete rep.sub_link; delete rep.sub_session_id; } // relink so the fee is right
  await setSetting(db, 'ads_' + id, JSON.stringify(rep));
  await logEvent(db, id, 'ads_lp_fee', rep.lp_fee
    ? `\u{1F4B3} Landing page fee set to $${rep.lp_fee} for ${client.business_name || client.name || client.email} — it rides the same checkout as the $249/mo.`
    : 'Landing page fee removed — billing is $249/mo only.');
  return c.json({ ok: true, lp_fee: rep.lp_fee || 0 });
});

// Fold the ads subscription into the same daily sweep that checks tag health,
// so a pending link that gets paid flips to active without anyone remembering.
async function adsBillingSweep(env) {
  if (!env.STRIPE_SECRET_KEY) return 0;
  const db = env.DB;
  const settings = await getSettings(db);
  let flipped = 0;
  for (const k of Object.keys(settings).filter((x) => /^ads_\d+$/.test(x))) {
    let rep = {}; try { rep = JSON.parse(settings[k] || '{}'); } catch {}
    if (!rep.sub_session_id || rep.sub_status === 'active') continue;
    const id = Number(k.slice(4));
    const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
    if (!client) continue;
    try {
      const st = await checkoutStatus(env.STRIPE_SECRET_KEY, rep.sub_session_id);
      const paid = st && (st.status === 'complete' || st.payment_status === 'paid' || st.subscription);
      if (paid) {
        rep.sub_status = 'active'; rep.sub_started = new Date().toISOString();
        await setSetting(db, k, JSON.stringify(rep));
        await logEvent(db, id, 'ads_billing_active',
          `\u{1F4B0} Ads management billing is live for ${client.business_name || client.name || client.email} — $249/mo recurring.`);
        flipped++;
      }
    } catch {}
  }
  return flipped;
}

// 💵 ADS ECONOMICS (8/19/2026) — the honest version of a client target.
// Back-solves from what the client actually earns: average ticket, margin,
// lead→client close rate, target new clients per month, expected CPC and
// landing-page conversion rate. Produces the leads needed, the most she can
// pay per lead and still profit, and the budget that implies.
// INTERNAL ONLY. It is a planning and monitoring baseline, never a promise —
// nobody can guarantee ad results and nothing here is written into client copy.
app.post('/api/clients/:id/ads-economics', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'no such client' }, 404);
  let body = {}; try { body = await c.req.json(); } catch {}
  const settings = await getSettings(db);
  let rep = {}; try { rep = JSON.parse(settings['ads_' + id] || '{}'); } catch {}
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  const pct = (v, d) => { let n = Number(v); if (!Number.isFinite(n) || n <= 0) return d; if (n > 1) n = n / 100; return n > 0 && n <= 1 ? n : d; };
  rep.econ = {
    ticket: num(body.ticket, (rep.econ && rep.econ.ticket) || 0),
    margin: pct(body.margin, (rep.econ && rep.econ.margin) || 0.6),
    close_rate: pct(body.close_rate, (rep.econ && rep.econ.close_rate) || 0.25),
    target_clients: num(body.target_clients, (rep.econ && rep.econ.target_clients) || 0),
    cpc: num(body.cpc, (rep.econ && rep.econ.cpc) || 0),
    lp_cvr: pct(body.lp_cvr, (rep.econ && rep.econ.lp_cvr) || 0.08),
  };
  const model = adsEconomics(rep.econ, rep.facts);
  rep.brief = adsPlan(client, rep, settings);   // the sheet rebuilds around the new numbers
  await setSetting(db, 'ads_' + id, JSON.stringify(rep));
  await logEvent(db, id, 'ads_economics',
    `\u{1F4B5} Ads economics set for ${client.business_name || client.name || client.email} — target ${rep.econ.target_clients || '?'} new clients/mo, ` +
    `${model.leads_needed || '?'} leads needed, max $${model.max_cpl || '?'}/lead, implied budget $${model.monthly_budget || '?'}/mo. Planning model only.`);
  return c.json({ ok: true, econ: rep.econ, model, brief: rep.brief });
});

// 👀 TAG WATCHER (8/19/2026, hourly) — after she pastes the tracking code into
// GoHighLevel, somebody has to press Re-check. Nobody should have to. This
// re-verifies any connected page whose tag is still missing and tells her the
// moment it goes green, so the pasting step ends by itself.
async function adsTagWatcher(env) {
  const db = env.DB;
  const settings = await getSettings(db);
  let flipped = 0;
  for (const k of Object.keys(settings).filter((x) => /^ads_\d+$/.test(x))) {
    let rep = {}; try { rep = JSON.parse(settings[k] || '{}'); } catch {}
    if (!rep.url) continue;
    const already = rep.checks && rep.checks.tracker && rep.checks.tracker.ok;
    if (already) continue;
    const id = Number(k.slice(4));
    const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
    if (!client) continue;
    try {
      const report = await adsVerify(env, id, rep.url);
      const nowOk = report.checks && report.checks.tracker && report.checks.tracker.ok;
      // adopt any IDs that appeared on the page at the same time
      const detGa4 = (report.checks && report.checks.ga4 && report.checks.ga4.id) || '';
      const detClar = (report.checks && report.checks.clarity && report.checks.clarity.id) || '';
      if (detGa4 && !rep.ga4_measurement) rep.ga4_measurement = String(detGa4).toUpperCase();
      if (detClar && !rep.clarity_id) rep.clarity_id = String(detClar);
      rep = { ...rep, ...report };
      await setSetting(db, k, JSON.stringify(rep));
      if (nowOk) {
        flipped++;
        const biz = client.business_name || client.name || client.email;
        await logEvent(db, id, 'ads_tag_live',
          `\u{1F440} Tracking code is live on ${rep.url} — spotted on its own, no Re-check needed. Calls, texts, forms and bookings are now being counted.`);
        await notifyOwner(env, settings, `\u{2705} Tracking is live for ${biz}`,
          `<p>The tracking code you pasted into GoHighLevel is now live on <a href="${rep.url}">${rep.url}</a>.</p>` +
          `<p>Calls, texts, forms and bookings are being counted from this moment, and their portal card will start filling in.</p>` +
          `<p><a href="${BASE_URL}">Open Mission Control</a></p>`);
      }
    } catch {}
  }
  return flipped;
}

// 🔁 WEEKLY RE-READ (Sundays) — clients add drips and change memberships without
// telling anyone. This re-reads every connected site once a week and only speaks
// up when the menu actually changed, so the keywords never quietly go stale.
async function adsWeeklyRescan(env) {
  const db = env.DB;
  const settings = await getSettings(db);
  const changed = [];
  for (const k of Object.keys(settings).filter((x) => /^ads_\d+$/.test(x))) {
    let rep = {}; try { rep = JSON.parse(settings[k] || '{}'); } catch {}
    if (!rep.url || !rep.track) continue;
    const id = Number(k.slice(4));
    const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
    if (!client) continue;
    try {
      const before = ((rep.facts && rep.facts.offerings) || []).map((o) => o.name).sort().join('|');
      const facts = await adsScan(env, id, rep.url);
      if (!facts || facts.error) continue;
      const after = facts.offerings.map((o) => o.name).sort().join('|');
      rep.facts = facts;
      rep.brief = adsPlan(client, rep, settings);
      await setSetting(db, k, JSON.stringify(rep));
      if (before && before !== after) {
        const beforeSet = new Set(before.split('|'));
        const added = facts.offerings.map((o) => o.name).filter((x) => !beforeSet.has(x));
        const afterSet = new Set(after.split('|'));
        const gone = before.split('|').filter((x) => x && !afterSet.has(x));
        changed.push({ biz: client.business_name || client.name || client.email, added, gone });
        await logEvent(db, id, 'ads_rescan',
          `\u{1F501} Weekly re-read: their menu changed${added.length ? ' — new: ' + added.join(', ') : ''}${gone.length ? ' — gone: ' + gone.join(', ') : ''}. Keywords and headlines rebuilt around it.`);
      }
    } catch {}
  }
  if (changed.length) {
    await notifyOwner(env, settings, `\u{1F501} ${changed.length} client menu(s) changed this week`,
      changed.map((c) => `<p><b>${c.biz}</b>` +
        (c.added.length ? `<br>New: ${c.added.join(', ')}` : '') +
        (c.gone.length ? `<br>Gone: ${c.gone.join(', ')}` : '') + '</p>').join('') +
      '<p>Their keywords and headlines have already been rebuilt around the new menu. Open the Build sheet to see it, then update the live campaign when you next touch it.</p>');
  }
  return changed.length;
}

// 🚨 SILENT-FAILURE ALARM (8/19/2026, daily noon cron) — the most expensive
// failure in ad management is a campaign that spends while the funnel is
// broken, because nothing looks wrong until the invoice arrives. For every
// client whose campaign is live, this asks Google Analytics whether ANY key
// event fired in the last 7 days. Zero is the alarm.
// ── BUDGET PACING + ANOMALY GUARD ─────────────────────────────────────────
// The existing watchdogs catch broken tracking. They do not catch the
// expensive surprises: a budget burning twice as fast as it should, a CPC that
// doubled overnight, or leads simply stopping. Those cost real money quietly,
// and the whole point of running this for her is that she should not have to
// remember to look. Runs daily; every alarm names the number and the action.
async function adsPacing(env) {
  const db = env.DB;
  const settings = await getSettings(db);
  const ids = Object.keys(settings).filter((k) => /^ads_\d+$/.test(k)).map((k) => Number(k.slice(4)));
  let fired = 0;
  for (const id of ids) {
    let rep = {}, perf = {}, econ = {};
    try { rep = JSON.parse(settings['ads_' + id] || '{}'); } catch {}
    try { perf = JSON.parse(settings['ads_perf_' + id] || '{}'); } catch {}
    try { econ = JSON.parse(settings['ads_econ_' + id] || '{}'); } catch {}
    if (rep.status !== 'live' && !rep.live_at) continue;      // only live accounts

    const alarms = [];

    // 1. PACING — only meaningful if we know both the budget and the spend.
    const daily = Number(econ.daily_budget || rep.daily_budget || 0);
    if (daily > 0 && perf.day_count > 0 && perf.cost > 0) {
      const actual = perf.cost / perf.day_count;
      const ratio = actual / daily;
      if (ratio >= 1.25) alarms.push(`Spending $${actual.toFixed(2)}/day against a $${daily.toFixed(2)} budget — ${Math.round((ratio - 1) * 100)}% over pace. Check for a budget change or a new campaign.`);
      else if (ratio <= 0.55) alarms.push(`Only spending $${actual.toFixed(2)}/day of a $${daily.toFixed(2)} budget. Usually means bids are too low or the keywords are too narrow — the ads are barely showing.`);
    }

    // 2. CPC SPIKE — compare this paste to the last one we kept.
    let prev = {};
    try { prev = JSON.parse(settings['ads_perf_prev_' + id] || '{}'); } catch {}
    if (prev.cpc > 0 && perf.cpc > 0 && perf.at !== prev.at) {
      const jump = perf.cpc / prev.cpc;
      if (jump >= 1.5) alarms.push(`Cost per click jumped from $${prev.cpc} to $${perf.cpc} (+${Math.round((jump - 1) * 100)}%). Usually a competitor bidding up, or match types loosening.`);
    }
    if (perf.at && perf.at !== prev.at) await setSetting(db, 'ads_perf_prev_' + id, JSON.stringify({ at: perf.at, cpc: perf.cpc, cost: perf.cost }));

    // 3. LEAD DROUGHT — the alarm that matters most, and needs no paste.
    const recent = await db.prepare(
      `SELECT COUNT(*) n FROM leads WHERE client_id = ? AND created_at >= datetime('now','-7 day')`).bind(id).first();
    const prior = await db.prepare(
      `SELECT COUNT(*) n FROM leads WHERE client_id = ? AND created_at >= datetime('now','-28 day') AND created_at < datetime('now','-7 day')`).bind(id).first();
    const n7 = Number(recent?.n || 0);
    const wkAvg = Number(prior?.n || 0) / 3;
    if (wkAvg >= 2 && n7 === 0) alarms.push(`Zero leads in 7 days, against about ${wkAvg.toFixed(1)}/week before. Check the campaign is still running and the form still works.`);
    else if (wkAvg >= 3 && n7 > 0 && n7 <= wkAvg * 0.4) alarms.push(`Leads dropped to ${n7} this week from about ${wkAvg.toFixed(1)}/week. Worth a look before it becomes a month.`);

    // 4. UNMARKED LEADS — the loop only closes if she marks outcomes.
    const un = await db.prepare(
      `SELECT COUNT(*) n FROM leads WHERE client_id = ? AND (status IS NULL OR status = '') AND created_at >= datetime('now','-30 day')`).bind(id).first();
    if (Number(un?.n || 0) >= 10) alarms.push(`${un.n} leads from the last 30 days are not marked booked or not. Marking them is what lets Google optimise for customers instead of form fills.`);

    for (const a of alarms) { await logEvent(db, id, 'ads_alarm', `\u{1F6A8} ${a}`); fired++; }
  }
  return fired;
}

async function adsSilentFailure(env) {
  const db = env.DB;
  const settings = await getSettings(db);
  const keys = Object.keys(settings).filter((k) => /^ads_\d+$/.test(k));
  const alarms = [];
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) return 0;
  let token = '';
  try {
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' }),
    });
    token = (await tr.json()).access_token || '';
  } catch {}
  if (!token) return 0;
  for (const k of keys) {
    let rep = {}; try { rep = JSON.parse(settings[k] || '{}'); } catch {}
    if (!rep.live_at || !rep.ga4_property) continue;          // only campaigns she has switched on
    const id = Number(k.slice(4));
    const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
    if (!client) continue;
    // a campaign enabled less than 8 days ago has not had time to prove anything
    if (Date.now() - Date.parse(rep.live_at) < 8 * 86400000) continue;
    try {
      const rr = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(rep.ga4_property)}:runReport`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }], metrics: [{ name: 'sessions' }, { name: 'keyEvents' }] }),
      });
      if (!rr.ok) continue;
      const d = await rr.json();
      const m = (d.rows && d.rows[0] && d.rows[0].metricValues) || [];
      const sessions = Number((m[0] || {}).value || 0);
      const events = Number((m[1] || {}).value || 0);
      const biz = client.business_name || client.name || client.email;
      if (sessions >= 25 && events === 0) {
        alarms.push({ id, biz, url: rep.url || '', sessions,
          why: 'the campaign is live and ' + sessions + ' people reached the page in 7 days, but NOT ONE key event fired' });
        await logEvent(db, id, 'error', `\u{1F6A8} Silent failure: ${sessions} sessions in 7 days on ${rep.url} and zero key events. Either tracking broke or the page converts nobody.`);
      } else if (sessions === 0) {
        alarms.push({ id, biz, url: rep.url || '', sessions: 0,
          why: 'the campaign is marked live but Google Analytics recorded ZERO sessions in 7 days — the ad is not running, or the tag is gone' });
        await logEvent(db, id, 'error', `\u{1F6A8} Silent failure: campaign marked live but zero sessions in 7 days on ${rep.url}.`);
      }
    } catch {}
  }
  if (alarms.length) {
    const html = '<p>Money may be going out with nothing coming back. ' + alarms.length + ' live campaign(s) tripped the silent-failure check:</p>' +
      alarms.map((a) => '<p><b>' + a.biz + '</b><br>' + a.why + '<br><a href="' + a.url + '">' + a.url + '</a></p>').join('') +
      '<p>First three things to check, in order: (1) is the tracking tag still in the GoHighLevel head code, (2) are the GA4 key events still imported as conversions in Google Ads, (3) has the funnel URL changed. Open the client in Mission Control and hit Re-check.</p>' +
      '<p style="color:#B42318"><b>Until it is resolved, consider pausing spend in Google Ads.</b> Mission Control never pauses a campaign for you.</p>';
    await notifyOwner(env, settings, '\u{1F6A8} ' + alarms.length + ' live campaign(s) spending with nothing to show', html);
  }
  return alarms.length;
}

// 📋 HEAD CODE FOR GOHIGHLEVEL (8/19/2026) — the exact tags she pastes, filled
// in with THIS client's real IDs. Two ways, and never both at once:
//   A) one tag  — our /t/<id>/t.js, which loads Google Analytics + Clarity and
//      binds the four key events (including the GoHighLevel iframe bridge)
//   B) native   — Google's own gtag + Microsoft's own Clarity tag, plus our
//      events-only tag so calls/texts/forms/bookings still get counted
// Pasting A and B together would double-count pageviews; the UI says so plainly.
app.get('/api/clients/:id/head-code', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  const db = c.env.DB;
  const client = await db.prepare('SELECT * FROM clients WHERE id = ?').bind(id).first();
  if (!client) return c.json({ error: 'no such client' }, 404);
  const settings = await getSettings(db);
  let rep = {}; try { rep = JSON.parse(settings['ads_' + id] || '{}'); } catch {}
  const biz = client.business_name || client.name || client.email || ('Client ' + id);
  const ga4 = String(rep.ga4_measurement || '').trim();
  const clar = String(rep.clarity_id || '').trim();
  const gtm = String(rep.gtm_id || '').trim();
  const aw = String(rep.aw_id || '').trim();
  const S = '<' + 'script';
  const E = '<' + '/script>';

  const one = `<!-- ConversionCo tracking for ${biz} -->\n` +
    `<!-- Google Analytics + Clarity + call, text, form and booking events -->\n` +
    `${S} defer src="${BASE_URL}/t/${id}/t.js">${E}`;

  const eventsTag = `<!-- ConversionCo key events (call, text, form, booking) -->\n` +
    `${S} defer src="${BASE_URL}/t/${id}/t.js?mode=events">${E}`;

  const ga4Tag = ga4
    ? `<!-- Google tag (gtag.js) -->\n${S} async src="https://www.googletagmanager.com/gtag/js?id=${ga4}">${E}\n` +
      `${S}>\n  window.dataLayer = window.dataLayer || [];\n  function gtag(){dataLayer.push(arguments);}\n` +
      `  gtag('js', new Date());\n  gtag('config', '${ga4}');\n${E}`
    : '';

  const clarityTag = clar
    ? `<!-- Microsoft Clarity -->\n${S} type="text/javascript">\n  (function(c,l,a,r,i,t,y){\n` +
      `      c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};\n` +
      `      t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;\n` +
      `      y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);\n` +
      `  })(window, document, "clarity", "script", "${clar}");\n${E}`
    : '';

  const gtmTag = gtm
    ? `<!-- Google Tag Manager -->\n${S}>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':\n` +
      `new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],\n` +
      `j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=\n` +
      `'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);\n` +
      `})(window,document,'script','dataLayer','${gtm}');${E}`
    : '';

  const missing = [];
  if (!ga4) missing.push({ k: 'ga4', label: 'Google Analytics', how: 'Press "Set it all up" — Mission Control creates the property and fills this in. Or paste an existing G- ID under Tracking IDs.' });
  if (!clar) missing.push({ k: 'clarity', label: 'Microsoft Clarity', how: 'clarity.microsoft.com → sign in → New project → name it "' + biz + '", site type Website, paste the landing page URL → the project ID is in Settings → Overview. Paste it under Tracking IDs and this tag fills in.' });

  return c.json({
    ok: true, biz, ga4, clarity: clar, gtm, aw,
    one, eventsTag, ga4Tag, clarityTag, gtmTag,
    url: rep.url || '',
    trackerOnPage: !!(rep.checks && rep.checks.tracker && rep.checks.tracker.ok),
    missing,
    where: [
      'In GoHighLevel, open the funnel: Sites → Funnels → click the funnel.',
      'Click the gear / Settings on that funnel → Tracking Code.',
      'Paste into HEAD TRACKING CODE (not Body). Save.',
      'To cover every funnel and site in the sub-account instead: Settings → Tracking Code → Head.',
      'Publish or re-save the funnel, open the live URL once, then hit Re-check here.',
    ],
  });
});

// Portal analytics feed — the client's own numbers, on demand (GA4 is a live
// call, so the portal renders our own counts instantly and fills this in after).
app.get('/portal-ads/:id/:token', async (c) => {
  const id = Number(c.req.param('id')) || 0;
  if (c.req.param('token') !== await portalToken(c.env, 'portal', id)) return c.json({ error: 'nope' }, 403);
  const settings = await getSettings(c.env.DB);
  let rep = {}; try { rep = JSON.parse(settings['ads_' + id] || '{}'); } catch {}
  // The ROI story comes from OUR database, so it works whether or not Google
  // analytics is wired up. This is what a client actually wants to see, and
  // what makes the retainer obviously worth paying: spend in, bookings out.
  const roi = await adsRoi(c.env, id).catch(() => null);
  if (!rep.ga4_property) return c.json({ pending: 'no-property', roi });
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET || !c.env.GOOGLE_REFRESH_TOKEN) return c.json({ pending: 'no-google-auth', roi });
  try {
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.env.GOOGLE_CLIENT_ID, client_secret: c.env.GOOGLE_CLIENT_SECRET, refresh_token: c.env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' }),
    });
    const td = await tr.json();
    if (!td.access_token) return c.json({ pending: 'token-failed' });
    const rr = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(rep.ga4_property)}:runReport`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + td.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }], metrics: [{ name: 'sessions' }, { name: 'keyEvents' }, { name: 'totalUsers' }] }),
    });
    if (!rr.ok) return c.json({ pending: 'api-' + rr.status });
    const data = await rr.json();
    const m = (data.rows && data.rows[0] && data.rows[0].metricValues) || [];
    return c.json({ ok: true, sessions: Number((m[0] || {}).value || 0), keyEvents: Number((m[1] || {}).value || 0), users: Number((m[2] || {}).value || 0), roi });
  } catch (e) { return c.json({ pending: 'error', roi }); }
});

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    await ensureSchema(env.DB);
    if (event.cron === '0 12 * * *') {
      ctx.waitUntil(dailyUptime(env).catch((e) =>
        logEvent(env.DB, null, 'error', `Uptime check failed: ${e.message}`)
      ));
      ctx.waitUntil(reviewAskSweep(env).catch((e) =>
        logEvent(env.DB, null, 'error', `Review ask sweep failed: ${e.message}`)
      ));
      ctx.waitUntil(adsWatchdog(env).catch((e) =>
        logEvent(env.DB, null, 'error', `Ads watchdog failed: ${e.message}`)
      ));
      ctx.waitUntil(adsSilentFailure(env).catch((e) =>
        logEvent(env.DB, null, 'error', `Silent-failure check failed: ${e.message}`)
      ));
      ctx.waitUntil(adsBillingSweep(env).catch((e) =>
        logEvent(env.DB, null, 'error', `Ads billing sweep failed: ${e.message}`)
      ));
      ctx.waitUntil(adsPacing(env).catch((e) =>
        logEvent(env.DB, null, 'error', `Ads pacing check failed: ${e.message}`)
      ));
      if (new Date(event.scheduledTime || Date.now()).getUTCDay() === 0) {
        ctx.waitUntil(adsWeeklyRescan(env).catch((e) =>
          logEvent(env.DB, null, 'error', `Weekly ads re-read failed: ${e.message}`)
        ));
      }
      ctx.waitUntil(gscRankSnapshot(env).catch((e) =>
        logEvent(env.DB, null, 'error', `Rankings snapshot failed: ${e.message}`)
      ));
      ctx.waitUntil(backupDatabase(env).catch((e) =>
        logEvent(env.DB, null, 'error', `Backup failed: ${e.message}`)
      ));
      ctx.waitUntil(githubTokenHealth(env).catch((e) =>
        logEvent(env.DB, null, 'error', `Token health check failed: ${e.message}`)
      ));
      if (new Date(event.scheduledTime || Date.now()).getUTCDay() === 1) {
        ctx.waitUntil(weeklyOwnerDigest(env).catch((e) =>
          logEvent(env.DB, null, 'error', `Owner digest failed: ${e.message}`)
        ));
        ctx.waitUntil(adsWeeklyClientReport(env).catch((e) =>
          logEvent(env.DB, null, 'error', `Weekly ads report failed: ${e.message}`)
        ));
      }
      if (new Date(event.scheduledTime || Date.now()).getUTCDay() === 0) {
        // Sunday: pull Google Search Console for every live client — the exact
        // positions land in settings the day before the Monday weekly reports run
        ctx.waitUntil(getSettings(env.DB).then((s) => gscPullAll(env, s)).catch((e) =>
          logEvent(env.DB, null, 'error', `GSC pull failed: ${e.message}`)
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
    ctx.waitUntil(editWatch(env, settings).catch((e) =>
      logEvent(env.DB, null, 'error', `Edit-watcher failed: ${e.message}`)
    ));
    ctx.waitUntil(continuePublish(env, settings).catch((e) =>
      logEvent(env.DB, null, 'error', `Publish-now continuation failed: ${e.message}`)
    ));
    ctx.waitUntil(pollBilling(env).catch((e) =>
      logEvent(env.DB, null, 'error', `Billing poll failed: ${e.message}`)
    ));
    ctx.waitUntil(buildWatchdog(env, settings).catch((e) =>
      logEvent(env.DB, null, 'error', `Build watchdog failed: ${e.message}`)
    ));
    ctx.waitUntil(autoNudges(env, settings).catch((e) =>
      logEvent(env.DB, null, 'error', `Auto-nudge failed: ${e.message}`)
    ));
    ctx.waitUntil(paymentFollowups(env, settings).catch((e) =>
      logEvent(env.DB, null, 'error', `Payment follow-up failed: ${e.message}`)
    ));
    ctx.waitUntil(downWatch(env, settings).catch((e) =>
      logEvent(env.DB, null, 'error', `Down watch failed: ${e.message}`)
    ));
    ctx.waitUntil(retryFailedEmails(env, settings).catch((e) =>
      logEvent(env.DB, null, 'error', `Email retry failed: ${e.message}`)
    ));
    ctx.waitUntil(queueWatch(env, settings).catch((e) =>
      logEvent(env.DB, null, 'error', `Queue watch failed: ${e.message}`)
    ));
    ctx.waitUntil(revisionRoundOneEmails(env, settings).catch((e) =>
      logEvent(env.DB, null, 'error', `Revision round one email failed: ${e.message}`)
    ));
    ctx.waitUntil(pollGoogleMeet(env, settings).catch(() => { /* self-throttled error logging inside */ }));
    ctx.waitUntil(adsTagWatcher(env).catch((e) =>
      logEvent(env.DB, null, 'error', `Ads tag watcher failed: ${e.message}`)
    ));
  },
};
