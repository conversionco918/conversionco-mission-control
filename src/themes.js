// One-click site themes. Each maps the design tokens in a site's :root block.
// Applying a theme rewrites those token values in site.css (GitHub + D1) — layout,
// pages, and content are untouched. Full custom styling still goes through a build session.
export const THEMES = {
  'warm-luxury': {
    label: 'Warm Luxury',
    tokens: { '--porcelain':'#F7F4EF','--bone':'#EFE8DE','--espresso':'#241D18','--night':'#1A1512','--cocoa':'#5C5148','--taupe':'#93867B','--gold':'#A8874F','--gold-soft':'#C3A878','--gold-wash':'#F1E8D8','--eucalyptus':'#7E8C7C' },
  },
  'soft-neutrals': {
    label: 'Soft Neutrals',
    tokens: { '--porcelain':'#FAF8F4','--bone':'#F2ECE2','--espresso':'#332B24','--night':'#282019','--cocoa':'#6B5D50','--taupe':'#A29383','--gold':'#B08D57','--gold-soft':'#D2B584','--gold-wash':'#F4EBDC','--eucalyptus':'#8CA58F' },
  },
  'coastal-navy': {
    label: 'Coastal Navy',
    tokens: { '--porcelain':'#F5F7F9','--bone':'#E9EEF3','--espresso':'#0A1C33','--night':'#071B33','--cocoa':'#41556E','--taupe':'#7E8FA3','--gold':'#C9A254','--gold-soft':'#DDBE7A','--gold-wash':'#F3EAD5','--eucalyptus':'#7E8C7C' },
  },
  'fresh-clinical': {
    label: 'Fresh Clinical',
    tokens: { '--porcelain':'#FDFEFE','--bone':'#F0F6F6','--espresso':'#123A3F','--night':'#0E2E32','--cocoa':'#3E6266','--taupe':'#7FA0A3','--gold':'#2FA8B5','--gold-soft':'#6CC6CF','--gold-wash':'#E2F4F6','--eucalyptus':'#7FB0A8' },
  },
  'rose-spa': {
    label: 'Rosé Spa',
    tokens: { '--porcelain':'#FBF6F3','--bone':'#F4EAE4','--espresso':'#3A2430','--night':'#2E1B26','--cocoa':'#6E4E5C','--taupe':'#A3808F','--gold':'#C98A7D','--gold-soft':'#DFAC9F','--gold-wash':'#F6E7E1','--eucalyptus':'#9AA58C' },
  },
};
