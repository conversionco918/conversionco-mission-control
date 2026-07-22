// GoHighLevel API 2.0 client (LeadConnector)
const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

export class GHL {
  constructor(token, locationId) {
    this.token = token;
    this.locationId = locationId;
  }

  async req(method, path, { query, body } = {}) {
    const url = new URL(BASE + path);
    if (query) for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Version: VERSION,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = data?.message || data?.error || text || res.statusText;
      throw new GHLError(`GHL ${method} ${path} -> ${res.status}: ${Array.isArray(msg) ? msg.join('; ') : msg}`, res.status, data);
    }
    return data;
  }

  // ---- Location ----
  async getLocation() {
    return this.req('GET', `/locations/${this.locationId}`);
  }

  // ---- Forms ----
  async listForms() {
    const data = await this.req('GET', '/forms/', {
      query: { locationId: this.locationId, limit: 50 },
    });
    return data.forms || [];
  }

  async formSubmissions({ formId, startAt, endAt, page = 1, limit = 100 } = {}) {
    const data = await this.req('GET', '/forms/submissions', {
      query: { locationId: this.locationId, formId, startAt, endAt, page, limit },
    });
    return data.submissions || [];
  }

  // ---- Surveys (multi-step intakes live here, not under /forms) ----
  async listSurveys() {
    const data = await this.req('GET', '/surveys/', {
      query: { locationId: this.locationId, limit: 50 },
    });
    return data.surveys || [];
  }

  async surveySubmissions({ surveyId, startAt, endAt, page = 1, limit = 100 } = {}) {
    const data = await this.req('GET', '/surveys/submissions', {
      query: { locationId: this.locationId, surveyId, startAt, endAt, page, limit },
    });
    return data.submissions || [];
  }

  // Unified: id may be "form:xxx" or "survey:xxx" (bare id = form)
  async listIntakeSources() {
    const [forms, surveys] = await Promise.all([
      this.listForms().catch(() => []),
      this.listSurveys().catch(() => []),
    ]);
    return [
      ...forms.map((f) => ({ id: `form:${f.id}`, name: `Form: ${f.name}` })),
      ...surveys.map((s) => ({ id: `survey:${s.id}`, name: `Survey: ${s.name}` })),
    ];
  }

  async intakeSubmissions(sourceId, opts = {}) {
    if (String(sourceId).startsWith('survey:')) {
      return this.surveySubmissions({ ...opts, surveyId: sourceId.slice(7) });
    }
    const formId = String(sourceId).startsWith('form:') ? sourceId.slice(5) : sourceId;
    return this.formSubmissions({ ...opts, formId });
  }

  // ---- Contacts ----
  async upsertContact({ email, name, phone }) {
    const body = { locationId: this.locationId, email };
    if (name) {
      const parts = String(name).trim().split(/\s+/);
      body.firstName = parts[0];
      if (parts.length > 1) body.lastName = parts.slice(1).join(' ');
    }
    if (phone) body.phone = phone;
    const data = await this.req('POST', '/contacts/upsert', { body });
    return data.contact || data;
  }

  async getContact(contactId) {
    const data = await this.req('GET', `/contacts/${contactId}`);
    return data.contact || data;
  }

  // ---- Email via Conversations ----
  async sendEmail({ contactId, subject, html, emailFrom }) {
    const body = {
      type: 'Email',
      contactId,
      subject,
      html,
    };
    if (emailFrom) body.emailFrom = emailFrom;
    return this.req('POST', '/conversations/messages', { body });
  }
}

export class GHLError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'GHLError';
    this.status = status;
    this.data = data;
  }
}
