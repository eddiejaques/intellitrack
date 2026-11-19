// This function is serialized by chrome.scripting and runs in an isolated world.
export function extractPage() {
  const safe = value => String(value ?? '').trim().slice(0,160)
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[email]')
    .replace(/(?:\+?\d[\d ().-]{6,}\d)/g,'[phone]')
    .replace(/https?:\/\/\S+/gi,'[url]');
  const meta = name => document.querySelector(`meta[name="${name}"],meta[property="${name}"]`)?.content;
  const labels = selector => [...document.querySelectorAll(selector)].slice(0,8).map(el => safe(el.textContent)).filter(Boolean);
  const types = new Set();
  const visit = (value,depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 8) return;
    for (const type of [value['@type']].flat()) if (typeof type === 'string' && /^[A-Za-z]+$/.test(type)) types.add(type);
    for (const child of Object.values(value)) visit(child,depth+1);
  };
  for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0,10)) {
    try { visit(JSON.parse(script.textContent.slice(0,100000))); } catch {}
  }
  return {url:location.href,title:safe(document.title),description:safe(meta('description')),
    og_type:safe(meta('og:type')),schema_types:[...types].slice(0,20),has_forms:Boolean(document.forms.length),
    field_types:[...new Set([...document.querySelectorAll('form input,form select,form textarea')].map(el => el.type))].slice(0,20),
    headings:labels('main h1,main h2,h1'),navigation:labels('nav a')};
}
