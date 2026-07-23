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
  standard: { amount: 49900, label: 'Standard Website Package', display: '$499' },
  premium: { amount: 64900, label: 'Premium Website + SEO Engine', display: '$649' },
  hosting: { amount: 4900, label: 'Website Hosting & Security', display: '$49/mo' },
};

export async function ensureCustomer(key, email, name) {
  const found = await stripeReq(key, 'GET', `/customers?email=${encodeURIComponent(email)}&limit=1`);
  if (found.data?.length) return found.data[0];
  return stripeReq(key, 'POST', '/customers', { email, ...(name ? { name } : {}) });
}

export async function sendInvoice(key, customerId, tierKey, businessName) {
  const p = PRICES[tierKey] || PRICES.standard;
  // draft invoice first, then attach the item to it, then finalize + send
  const invoice = await stripeReq(key, 'POST', '/invoices', {
    customer: customerId,
    collection_method: 'send_invoice',
    days_until_due: 7,
    description: `ConversionCo — ${p.label}${businessName ? ` for ${businessName}` : ''}`,
  });
  await stripeReq(key, 'POST', '/invoiceitems', {
    customer: customerId,
    invoice: invoice.id,
    amount: p.amount,
    currency: 'usd',
    description: `${p.label}${businessName ? ` — ${businessName}` : ''}`,
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

export async function hostingCheckout(key, customerId, businessName, returnUrl) {
  const session = await stripeReq(key, 'POST', '/checkout/sessions', {
    mode: 'subscription',
    customer: customerId,
    success_url: returnUrl,
    cancel_url: returnUrl,
    line_items: { 0: { quantity: 1, price_data: {
      currency: 'usd', unit_amount: PRICES.hosting.amount,
      recurring: { interval: 'month' },
      product_data: { name: `${PRICES.hosting.label}${businessName ? ` — ${businessName}` : ''}` },
    } } },
  });
  return { id: session.id, url: session.url };
}

export async function checkoutStatus(key, sessionId) {
  const s = await stripeReq(key, 'GET', `/checkout/sessions/${sessionId}`);
  return { complete: s.status === 'complete', subscription: s.subscription || null };
}
