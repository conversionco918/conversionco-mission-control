// Vibe engine: turns free-text emotion/feel ("moody and romantic", "beachy luxury")
// into the site's 10 design tokens. Deterministic color-theory rules — no external AI.

function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(100, s)) / 100; l = Math.max(0, Math.min(100, l)) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

const HUE_WORDS = [
  [/ocean|beach|coast|sea|wave|nautical/i, 205], [/navy/i, 216], [/sky/i, 208], [/blue/i, 212],
  [/forest|botanical|nature|jungle/i, 138], [/sage/i, 128], [/olive/i, 82], [/mint/i, 160],
  [/spa|zen|tranquil|serene/i, 166], [/teal/i, 180], [/aqua|turquoise/i, 175], [/lavender|lilac|violet|purple/i, 268],
  [/romantic|rose|blush|pink/i, 347], [/berry|plum/i, 328], [/wine|burgundy|maroon/i, 352],
  [/sunset|amber|orange/i, 26], [/terracotta|clay|desert|southwest/i, 18], [/peach|coral/i, 22],
  [/sand|beige|cream|ivory|neutral/i, 40], [/charcoal|slate|gr[ae]y|stone/i, 220],
  [/red|crimson/i, 4], [/golden|gold/i, 42], [/coffee|espresso|chocolate|brown|mocha/i, 28],
  [/emerald|green/i, 145], [/yellow|sunny|citrus/i, 46],
];

const SCORES = [
  { re: /dark|moody|dramatic|mysterious|midnight|bold|edgy|noir|deep/i, k: 'dark', v: 1 },
  { re: /light|airy|bright|fresh|clean|crisp|breez|open|minimal/i, k: 'dark', v: -1 },
  { re: /warm|cozy|golden|earthy|sunset|inviting|rustic|toasty/i, k: 'warm', v: 1 },
  { re: /cool|icy|ocean|crisp|clinical|glacial|arctic|mint/i, k: 'warm', v: -1 },
  { re: /vibrant|bold|energ|fun|playful|electric|lively|pop/i, k: 'vivid', v: 1 },
  { re: /muted|subtle|calm|soft|gentle|serene|quiet|understated|pastel/i, k: 'vivid', v: -1 },
  { re: /luxur|premium|elegant|upscale|high.?end|glam|rich|exclusive|sophisticat/i, k: 'lux', v: 1 },
  { re: /feminine|delicate|graceful/i, k: 'fem', v: 1 },
  { re: /masculine|strong|rugged|industrial/i, k: 'masc', v: 1 },
];

export function vibeToTokens(text) {
  const t = String(text || '').slice(0, 400);
  const hues = HUE_WORDS.filter(([re]) => re.test(t)).map(([, h]) => h);
  const s = { dark: 0, warm: 0, vivid: 0, lux: 0, fem: 0, masc: 0 };
  for (const { re, k, v } of SCORES) if (re.test(t)) s[k] += v;

  // base hue: first concrete hue word, else derived from temperature/gender feel
  let base = hues.length ? hues[0] : (s.warm > 0 ? 32 : s.warm < 0 ? 206 : s.fem ? 345 : s.masc ? 218 : 35);
  if (s.fem && !hues.length) base = 347;
  // accent: gold for luxury, otherwise a second hue word, otherwise warm-shifted analog
  const accent = s.lux > 0 ? 42 : (hues[1] ?? (base + (s.warm >= 0 ? 24 : -18)));

  const vividness = s.vivid > 0 ? 1 : s.vivid < 0 ? -1 : 0;
  const darkness = s.dark > 0 ? 1 : s.dark < 0 ? -1 : 0;

  const neutralS = vividness > 0 ? 22 : vividness < 0 ? 8 : 14;   // background tint strength
  const deepS = vividness > 0 ? 42 : 26;                            // dark-section saturation
  const accS = vividness > 0 ? 62 : s.lux > 0 ? 50 : 44;           // accent saturation
  const deepL = darkness > 0 ? 9 : darkness < 0 ? 16 : 12;         // dark-section lightness
  const bgL = darkness > 0 ? 96 : 97.5;

  return {
    label: describe(base, s, hues),
    tokens: {
      '--porcelain': hsl(base, neutralS * 0.6, bgL),
      '--bone': hsl(base, neutralS, bgL - 5.5),
      '--espresso': hsl(base, deepS, deepL + 5),
      '--night': hsl(base, deepS + 6, deepL),
      '--cocoa': hsl(base, Math.min(30, deepS * 0.7), 38),
      '--taupe': hsl(base, Math.min(24, deepS * 0.5), 60),
      '--gold': hsl(accent, accS, 50),
      '--gold-soft': hsl(accent, accS - 6, 66),
      '--gold-wash': hsl(accent, Math.min(45, accS), 92),
      '--eucalyptus': hsl(base + 100, 16, 55),
    },
  };
}

function describe(base, s, hues) {
  const temp = s.warm > 0 ? 'warm' : s.warm < 0 ? 'cool' : 'balanced';
  const depth = s.dark > 0 ? 'deep' : s.dark < 0 ? 'airy' : 'soft';
  const fam = base >= 330 || base < 10 ? 'rose/red' : base < 35 ? 'terracotta/amber' : base < 55 ? 'golden/sand'
    : base < 100 ? 'olive' : base < 170 ? 'green' : base < 200 ? 'teal' : base < 250 ? 'blue' : base < 300 ? 'violet' : 'berry';
  return `${depth} ${temp} ${fam}${s.lux > 0 ? ' with luxury gold accents' : ''}`;
}
