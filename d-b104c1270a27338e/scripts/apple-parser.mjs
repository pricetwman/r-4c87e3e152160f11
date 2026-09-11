// Read only Apple's public, inert metrics JSON; never execute page JavaScript.
const SCREENS = {'iphone-18-pro':'6.3','iphone-18-pro-max':'6.9','iphone-duo':'7.6','iphone-17':'6.3','iphone-17e':'6.1','iphone-air':'6.5','iphone-16':'6.1'};
const clean = value => String(value ?? '').replace(/\s+/gu,' ').trim();
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

function readMetrics(html, currency) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  const matches = scripts.filter(([,attrs]) => /\bid\s*=\s*["']metrics["']/i.test(attrs));
  if (matches.length !== 1) throw new Error('Expected one Apple metrics JSON block');
  const data = JSON.parse(matches[0][2]).data;
  if (data?.currency !== currency || !Array.isArray(data.products)) throw new Error('Currency or product schema mismatch');
  return data.products;
}

function unlockedPrices(html, market, page, model, storage) {
  // US static selection anchors explicitly say unlocked / connect later. Their
  // visible full amount must independently agree with the metrics amount.
  return [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi)].flatMap(([,href,body]) => {
    let url;
    try { url = new URL(href, market.base); } catch { return []; }
    const prefix = `${new URL(market.base).pathname}/${page.slug}/${SCREENS[model]}-inch-display-${storage.toLowerCase()}-`;
    if (url.origin !== 'https://www.apple.com' || !url.pathname.startsWith(prefix) || !url.pathname.endsWith('-unlocked')) return [];
    const match = body.match(/<span\b[^>]*class=["'][^"']*\bcurrent_price\b[^"']*["'][^>]*>\s*\$([\d,]+\.\d{2})\s*<\/span>/i);
    return match ? [Number(match[1].replaceAll(',',''))] : [];
  });
}

export function parseApplePrices(html, {market,page,products}) {
  const rows = readMetrics(html, market.currency);
  const sourceUrl = `${market.base}/${page.slug}`;
  const outcomes = page.models.flatMap(model => products[model].storage.map(storage => {
    const identity = `${products[model].name} ${storage} `;
    const variants = rows.filter(row => clean(row.name).startsWith(identity));
    const amounts = variants.map(row => row.price?.fullPrice);
    let error = !variants.length ? 'Model/capacity missing from official page' : null;
    if (variants.some(row => row.category !== 'iphone' || !row.sku || !row.partNumber || !positive(row.price?.fullPrice))) error = 'Invalid full-price SKU record';
    if (new Set(amounts).size > 1) error = 'Color/SKU prices disagree';
    if (!error && market.code === 'US') {
      const unlocked = unlockedPrices(html,market,page,model,storage);
      if (!unlocked.length || unlocked.some(amount => amount !== amounts[0])) error = 'US unlocked full-price verification failed';
    }
    const common = {model,storage,country:market.code,currency:market.currency,sourceUrl};
    return error ? {failure:{...common,error}} : {observation:{...common,price:amounts[0]}};
  }));
  return {observations:outcomes.flatMap(item=>item.observation ? [item.observation]:[]),failures:outcomes.flatMap(item=>item.failure ? [item.failure]:[])};
}
