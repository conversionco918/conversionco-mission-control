// Minimal Stripe REST client (no SDK) for invoices + hosting subscription.
// Pricing: Standard $499, Premium $649 one-time; hosting $49/mo (started manually at the end).

const API = 'https://api.stripe.com/v1';

function form(params, prefix = '') {
  // flatten nested objects/arrays into Stripe's form encoding
  const out = [];
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') out.push(form(v, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.filter(Boolean).join('&');
}

async function stripeReq(key, method, path, params) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: params ? form(params) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || `Stripe ${res.status}`;
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return data;
}

export const PRICES = {
  standard: { amount: 64900, label: 'Standard Website Package', display: '$649' },
  premium: { amount: 99900, label: 'Premium Website + SEO Engine', display: '$999' },
  hosting: { amount: 4900, label: 'Website Hosting & Security', display: '$49/mo' },
  // dormant tiers — not shown anywhere; re-enable in the card UI if Tiffany's situation changes
  care199: { amount: 19900, label: 'Care Plan — Growth (content + reviews)', display: '$199/mo' },
  care399: { amount: 39900, label: 'Care Plan — Dominance (full service)', display: '$399/mo' },
};

export async function ensureCustomer(key, email, name) {
  const found = await stripeReq(key, 'GET', `/customers?email=${encodeURIComponent(email)}&limit=1`);
  if (found.data?.length) return found.data[0];
  return stripeReq(key, 'POST', '/customers', { email, ...(name ? { name } : {}) });
}

export function halfDisplay(tierKey) {
  const p = PRICES[tierKey] || PRICES.standard;
  return `$${(p.amount / 2 / 100).toFixed(2).replace(/\.00$/, '')}`;
}

// half: 'deposit' (50% to start the build) | 'final' (50% on delivery) | undefined (full, legacy)
export async function sendInvoice(key, customerId, tierKey, businessName, half) {
  const p = PRICES[tierKey] || PRICES.standard;
  const amount = half ? Math.round(p.amount / 2) : p.amount;
  const suffix = half === 'deposit' ? ' — 50% deposit (build begins on payment)'
    : half === 'final' ? ' — final 50% balance (your website is ready)' : '';
  // draft invoice first, then attach the item to it, then finalize + send
  const invoice = await stripeReq(key, 'POST', '/invoices', {
    customer: customerId,
    collection_method: 'send_invoice',
    days_until_due: 7,
    description: `ConversionCo — ${p.label}${suffix}${businessName ? ` for ${businessName}` : ''}`,
  });
  await stripeReq(key, 'POST', '/invoiceitems', {
    customer: customerId,
    invoice: invoice.id,
    amount,
    currency: 'usd',
    description: `${p.label}${suffix}${businessName ? ` — ${businessName}` : ''}`,
  });
  const finalized = await stripeReq(key, 'POST', `/invoices/${invoice.id}/finalize`, {});
  let sent = finalized;
  try { sent = await stripeReq(key, 'POST', `/invoices/${invoice.id}/send`, {}); } catch { /* email sending may be off in Stripe settings; hosted link still works */ }
  return { id: sent.id, status: sent.status, url: sent.hosted_invoice_url };
}

export async function invoiceStatus(key, invoiceId) {
  const inv = await stripeReq(key, 'GET', `/invoices/${invoiceId}`);
  return { status: inv.status, paid: inv.status === 'paid', url: inv.hosted_invoice_url };
}

export async function hostingCheckout(key, customerId, businessName, returnUrl, planKey = 'hosting') {
  const plan = PRICES[planKey] && ['hosting', 'care199', 'care399'].includes(planKey) ? PRICES[planKey] : PRICES.hosting;
  const session = await stripeReq(key, 'POST', '/checkout/sessions', {
    mode: 'subscription',
    customer: customerId,
    success_url: returnUrl,
    cancel_url: returnUrl,
    line_items: { 0: { quantity: 1, price_data: {
      currency: 'usd', unit_amount: plan.amount,
      recurring: { interval: 'month' },
      product_data: { name: `${plan.label}${businessName ? ` — ${businessName}` : ''}` },
    } } },
  });
  return { id: session.id, url: session.url };
}

export async function checkoutStatus(key, sessionId) {
  const s = await stripeReq(key, 'GET', `/checkout/sessions/${sessionId}`);
  return { complete: s.status === 'complete', subscription: s.subscription || null };
}
