// Default email templates. Editable in the dashboard (stored in D1 settings,
// these are just the starting point). Merge fields: {{name}}, {{form_link}}
// Personal-professional style: short plain paragraphs, one visible link, no buttons
// or heavy styling — reads like a person wrote it (best inbox placement), still polished.
export const DEFAULT_TEMPLATES = {
  intake1_subject: "Getting started on your website",
  intake1_body: `
<p>Hi {{name}},</p>
<p>Excited to get started on your website. The first step is a short intake form — about 10 minutes. It tells us about your business and the style you like, so the site feels like you:</p>
<p><a href="{{form_link}}">{{form_link}}</a></p>
<p>Have your business name, service area, and contact info handy. If you have a logo, you can send it over after.</p>
<p>Once you submit, we'll review everything and reach out about pricing and next steps. Any questions at all, just reply to this email — a real person reads every reply.</p>
<p>Talk soon,<br>The ConversionCo Team</p>
`,
  intake2_subject: "You're on the books — one last form",
  intake2_body: `
<p>Hi {{name}},</p>
<p>Welcome aboard — we're excited to build this with you.</p>
<p>The last step before design starts is your Website Vision form. It's where you give us your menu and pricing, the look and feel you want, and your booking setup, so everything on the site is exactly right:</p>
<p><a href="{{form_link}}">{{form_link}}</a></p>
<p>As soon as you submit it, our build process kicks off and you'll have a preview link shortly after. Questions? Just reply.</p>
<p>Talk soon,<br>The ConversionCo Team</p>
`,
};

export const BOOKING_TEMPLATES = {
  booking_subject: "Got your intake — let's pick a time to talk",
  booking_body: `
<p>Hi {{name}},</p>
<p>Your intake just came through — thank you! We're already excited about what we can build for you.</p>
<p>Next step is a quick call to walk through your goals and map out your website plan. Grab whatever time works best here:</p>
<p><a href="{{booking_link}}">{{booking_link}}</a></p>
<p>Once you book, you'll get a confirmation with a Google Meet link — that's where we'll meet. Any questions before then, just reply.</p>
<p>Talk soon,<br>The ConversionCo Team</p>
`,
};

export const DEFAULT_SETTINGS = {
  booking_link: '',
  notify_email: 'conversionco918@gmail.com',
  sites_repo: 'conversionco918/conversionco-client-sites',
  ghl_location_id: 'Rl6440Fbo39WBs8mJaIV', // ConversionCo GHL sub-account
  form1_id: '',
  form2_id: '',
  form1_link: 'https://conversionco918.com/intake-form-for-clients',
  form2_link: 'https://conversionco918.com/website-vision-intake',
  email_from: '',
  last_poll_at: '',
};

export function renderTemplate(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}
