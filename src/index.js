import { Hono } from 'hono';
import { GHL } from './ghl.js';
import { DEFAULT_TEMPLATES, BOOKING_TEMPLATES, DEFAULT_SETTINGS, renderTemplate } from './emails.js';
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
  `CREATE INDEX IF NOT EXISTS idx_events_client ON events(client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_clients_stage ON clients(stage)`,
];
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA_SQL.map((s) => db.prepare(s)));
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
  for (const k of ['stage', 'notes', 'name', 'phone', 'business_name', 'preview_url', 'live_url']) {
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

// ---------------- API: settings & GHL utilities ----------------
app.post('/api/settings', async (c) => {
  const body = await c.req.json();
  const allowed = [
    'ghl_location_id', 'form1_id', 'form2_id', 'form1_link', 'form2_link', 'email_from',
    'intake1_subject', 'intake1_body', 'intake2_subject', 'intake2_body',
    'booking_link', 'booking_subject', 'booking_body',
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

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    await ensureSchema(env.DB);
    const settings = await getSettings(env.DB);
    ctx.waitUntil(pollForms(env, settings).catch((e) =>
      logEvent(env.DB, null, 'error', `Poll failed: ${e.message}`)
    ));
  },
};
