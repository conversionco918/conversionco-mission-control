// Default email templates. Editable in the dashboard (stored in D1 settings,
// these are just the starting point). Merge fields: {{name}}, {{form_link}}
export const DEFAULT_TEMPLATES = {
  intake1_subject: "Let's get started on your website! (Step 1 of 2)",
  intake1_body: `
<p>Hi {{name}},</p>
<p>I'm so excited to start building your website! The first step is a quick intake form — it tells me about you, your business, and the websites you love so I can make yours feel like <em>you</em>.</p>
<p><strong>Here's what to have handy before you start:</strong></p>
<ul>
  <li>Your business name, service area, and contact info</li>
  <li>3 websites you like the look of (any industry — just vibes!)</li>
  <li>Your logo if you have one (you can email it to me after)</li>
</ul>
<p style="margin:24px 0;">
  <a href="{{form_link}}" style="background:#071B33;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">Start Intake Form 1 &rarr;</a>
</p>
<p style="font-size:12.5px;color:#667788;">Button not working? Copy this link into your browser:<br><span style="color:#0B1D33;word-break:break-all;">{{form_link}}</span></p>
<p>It takes about 10 minutes. Once you submit it, I'll review everything and reach out to go over pricing and next steps.</p>
<p>Talk soon,<br>The ConversionCo Team</p>
`,
  intake2_subject: "You're officially on the books! Here's Step 2",
  intake2_body: `
<p>Hi {{name}},</p>
<p>Welcome aboard — I can't wait to build this with you! 🎉</p>
<p>The final step before I start designing is your <strong>Website Vision form</strong>. This is where you tell me your IV menu, memberships, look &amp; feel, and booking setup so everything on the site is exactly right.</p>
<p style="margin:24px 0;">
  <a href="{{form_link}}" style="background:#071B33;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">Start the Website Vision Form &rarr;</a>
</p>
<p style="font-size:12.5px;color:#667788;">Button not working? Copy this link into your browser:<br><span style="color:#0B1D33;word-break:break-all;">{{form_link}}</span></p>
<p>As soon as you submit it, my build process kicks off automatically and I'll have a preview link for you shortly after.</p>
<p>Talk soon,<br>The ConversionCo Team</p>
`,
};

export const BOOKING_TEMPLATES = {
  booking_subject: "Got your blueprint! Let's pick a time to talk 📅",
  booking_body: `
<p>Hi {{name}},</p>
<p>Your Business Growth Blueprint just landed in my inbox — I'm already excited about what we can build for you!</p>
<p>Next step: a quick call to walk through your goals and map out your website plan. Grab whatever time works best for you:</p>
<p style="margin:24px 0;">
  <a href="{{booking_link}}" style="background:#071B33;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">Pick Your Call Time &rarr;</a>
</p>
<p style="font-size:12.5px;color:#667788;">Button not working? Copy this link into your browser:<br><span style="color:#0B1D33;word-break:break-all;">{{booking_link}}</span></p>
<p>As soon as you book, you'll get a confirmation with a Google Meet link — that's where we'll meet.</p>
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
