// SEO Score engine: deterministic 0-100 audit computed from the client's actual
// site files, uptime record, and launch checklist. Every point is defensible.

const LAUNCH_KEYS = ['domain', 'gbp', 'gbp_full', 'reviewlink', 'gsc', 'sitemap', 'citations', 'reviews5'];
const LAUNCH_LABELS = {
  domain: 'Connect their real domain', gbp: 'Create the Google Business Profile',
  gbp_full: 'Fully build out the GBP (photos, services, hours)', reviewlink: 'Wire the Google review link',
  gsc: 'Verify Google Search Console', sitemap: 'Submit the sitemap in Search Console',
  citations: 'Place core citations (Yelp, Apple Maps, Bing, Healthgrades)', reviews5: 'Collect the first 5 Google reviews',
};

export async function computeScore(db, client, settings) {
  // resolve slug
  const metas = (await db.prepare(`SELECT slug, content FROM site_files WHERE path='site-meta.json'`).all()).results || [];
  let slug = null;
  for (const m of metas) { try { if (JSON.parse(m.content).client_id === client.id) { slug = m.slug; break; } } catch {} }
  if (!slug) return null;

  const rows = (await db.prepare(
    `SELECT path, content FROM site_files WHERE slug=? AND is_base64=0`
  ).bind(slug).all()).results || [];
  const html = rows.filter((r) => r.path.endsWith('.html'));
  const all = Object.fromEntries(rows.map((r) => [r.path, r.content]));
  const tips = [];

  // ---- 1. Technical foundation (0-20) ----
  let tech = 0;
  if (all['sitemap.xml']) tech += 3; else tips.push({ pts: 3, t: 'Add a sitemap.xml' });
  if (all['robots.txt']) tech += 2; else tips.push({ pts: 2, t: 'Add robots.txt' });
  if (all['404.html']) tech += 1;
  const withDesc = html.filter((r) => /<meta name="description"/.test(r.content)).length;
  tech += Math.round(4 * (html.length ? withDesc / html.length : 0));
  const withCanon = html.filter((r) => /rel="canonical"/.test(r.content)).length;
  tech += Math.round(3 * (html.length ? withCanon / html.length : 0));
  const schemaCount = html.filter((r) => /application\/ld\+json/.test(r.content)).length;
  tech += schemaCount >= 4 ? 4 : schemaCount >= 2 ? 3 : schemaCount >= 1 ? 2 : 0;
  if (schemaCount < 2) tips.push({ pts: 2, t: 'Add structured data (schema) to more pages' });
  if (all['privacy-policy.html'] && all['terms.html']) tech += 2; else tips.push({ pts: 2, t: 'Add privacy policy & terms pages' });
  if (rows.some((r) => r.path.startsWith('img/logo.')) || (await db.prepare(`SELECT 1 AS x FROM site_files WHERE slug=? AND path='logo'`).bind(`_assets-${client.id}`).first())) tech += 1;
  else tips.push({ pts: 1, t: 'Upload the client logo' });
  tech = Math.min(20, tech);

  // ---- 2. Content depth (0-25) ----
  const legal = new Set(['privacy-policy.html', 'terms.html', '404.html', 'review-us.html', 'bag-lab.html']);
  const core = html.filter((r) => !legal.has(r.path) && !r.path.startsWith('blog') && !/^[a-z-]*iv-therapy-|-iv-therapy\.html$/.test(r.path)).length;
  const dripPages = html.filter((r) => /-iv-therapy\.html$/.test(r.path) && !r.path.startsWith('iv-therapy-')).length;
  const cityPages = html.filter((r) => r.path.startsWith('iv-therapy-')).length;
  const blogPosts = html.filter((r) => r.path.startsWith('blog-')).length;
  let content = Math.min(8, core * 2);
  content += Math.min(6, dripPages * 1.5);
  content += Math.min(4, cityPages * 1.5);
  content += Math.min(7, blogPosts * 1.5);
  content = Math.min(25, Math.round(content));
  if (dripPages === 0) tips.push({ pts: 6, t: 'Add per-drip landing pages (Premium)' });
  if (cityPages === 0) tips.push({ pts: 4, t: 'Add city landing pages (Premium)' });
  if (blogPosts < 4) tips.push({ pts: Math.min(7, (4 - blogPosts) * 1.5), t: 'Grow the blog — weekly posts compound (Premium)' });

  // ---- 3. Local signals (0-20) ----
  let local = 0;
  const allHtml = html.map((r) => r.content).join(' ');
  if (/MedicalBusiness|LocalBusiness/.test(allHtml)) local += 5; else tips.push({ pts: 5, t: 'Add LocalBusiness schema' });
  if (/tel:\+?1?\d{10}/.test(allHtml)) local += 3;
  const titleCity = html.filter((r) => /<title>[^<]*(Tulsa|Owasso|Oklahoma|OK\b)/i.test(r.content)).length;
  local += Math.round(4 * (html.length ? Math.min(1, titleCity / Math.max(1, html.length - 3)) : 0));
  if (cityPages > 0) local += 4;
  if (all['review-us.html']) local += 4; else tips.push({ pts: 4, t: 'Add the review funnel page' });
  local = Math.min(20, local);

  // ---- 4. Reliability (0-15) from uptime record ----
  let upStat = null; try { upStat = JSON.parse(settings[`uptime_${client.id}`] || 'null'); } catch {}
  let reliability = 15, upPct = null;
  if (upStat && upStat.total > 0) {
    upPct = Math.round(100 * (upStat.total - (upStat.fails || 0)) / upStat.total);
    reliability = Math.round(15 * upPct / 100);
  }

  // ---- 5. Off-site launch checklist (0-20) ----
  let cl = {}; try { cl = JSON.parse(client.launch_checklist || '{}'); } catch {}
  const done = LAUNCH_KEYS.filter((k) => cl[k]);
  const growth = Math.round(20 * done.length / LAUNCH_KEYS.length);
  for (const k of LAUNCH_KEYS) if (!cl[k]) tips.push({ pts: 2.5, t: LAUNCH_LABELS[k] });

  const total = Math.min(100, tech + content + local + reliability + growth);
  tips.sort((a, b) => b.pts - a.pts);
  return {
    total,
    breakdown: {
      technical: { score: tech, max: 20 },
      content: { score: content, max: 25 },
      local: { score: local, max: 20 },
      reliability: { score: reliability, max: 15, uptimePct: upPct },
      offsite: { score: growth, max: 20, done: done.length, of: LAUNCH_KEYS.length },
    },
    pages: { total: html.length, drips: dripPages, cities: cityPages, blogPosts },
    topTips: tips.slice(0, 3).map((x) => `${x.t} (+${x.pts} pts)`),
  };
}
