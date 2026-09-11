import {productSlug} from './catalog-pages.mjs';

export function taipeiDate(iso) {
  if (!Number.isFinite(Date.parse(iso))) throw new Error('Invalid collection time');
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(iso));
}

function verified(entry, currency, now) {
  const checked = Date.parse(entry?.checkedAt);
  if (entry?.source !== 'apple' || entry.currency !== currency ||
      !Number.isFinite(entry.price) || entry.price <= 0 ||
      !Number.isFinite(checked) || checked > Date.parse(now)) return false;
  try {
    const url = new URL(entry.sourceUrl);
    return url.protocol === 'https:' &&
      ['www.apple.com', 'www.apple.com.cn'].includes(url.hostname) &&
      !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}

function validHistoryPoint(point, currency, now, date) {
  if (!verified(point, currency, now) || !/^\d{4}-\d{2}-\d{2}$/.test(point.date)) return false;
  const parsed = new Date(`${point.date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === point.date &&
    taipeiDate(point.checkedAt) === point.date && point.date <= date;
}

function currentEntry({found, old, failure, market, model, product, now}) {
  if (found) return {
    price: found.price, checkedAt: found.checkedAt ?? now, source: 'apple',
    sourceUrl: found.sourceUrl, currency: market.currency,
    status: 'current', lastAttemptAt: now
  };
  if (verified(old, market.currency, now)) return {
    ...old, status: 'stale', lastAttemptAt: now,
    error: failure?.error ?? 'No successful observation'
  };
  const slug = productSlug(model, product);
  return {
    price: null, checkedAt: null, source: 'apple',
    sourceUrl: failure?.sourceUrl ?? `${market.base}/${slug}`,
    currency: market.currency, status: 'unavailable', lastAttemptAt: now,
    error: failure?.error ?? 'No verified official price yet'
  };
}

function historyPoints({previous, found, market, now, date}) {
  const retained = (Array.isArray(previous) ? previous : []).filter(point =>
    validHistoryPoint(point, market.currency, now, date));
  const checkedAt = found?.checkedAt ?? now;
  const observedDate = taipeiDate(checkedAt);
  const points = found ? [
    ...retained.filter(point => point.date !== observedDate),
    {date: observedDate, price: found.price, checkedAt, source: 'apple',
      sourceUrl: found.sourceUrl, currency: market.currency}
  ] : retained;
  return [...new Map(points.map(point => [point.date, point])).values()]
    .sort((first, second) => first.date.localeCompare(second.date));
}

function buildVariant(context, model, storage, market) {
  const {previousPrices, previousHistory, observations, failures, now, date} = context;
  const matches = item => item.model === model &&
    item.storage === storage && item.country === market.code;
  const found = observations.find(matches);
  const failure = failures.find(matches);
  const old = previousPrices.demo === false ? previousPrices[model]?.[storage]?.[market.code] : null;
  const previous = previousHistory.demo === false ? previousHistory[model]?.[storage]?.[market.code] : [];
  return {
    entry: currentEntry({found, old, failure, market, model, product: context.products[model], now}),
    points: historyPoints({previous, found, market, now, date})
  };
}

function projectRecords(records, field) {
  return Object.fromEntries(records.map(([model, capacities]) => [model,
    Object.fromEntries(capacities.map(([storage, countries]) => [storage,
      Object.fromEntries(countries.map(([country, value]) => [country, value[field]]))
    ]))
  ]));
}

export function mergeObservations(context) {
  const {products, markets, now} = context;
  const date = taipeiDate(now);
  const records = Object.entries(products).map(([model, product]) => [model,
    product.storage.map(storage => [storage, markets.map(market => [market.code,
      buildVariant({...context, date}, model, storage, market)
    ])])
  ]);
  return {
    prices: {
      updated: now, observationDate: date, demo: false,
      notice: 'Apple 官方空機全額售價；美國價格未含州／地方銷售稅。失敗時保留上次成功紀錄並標示過期。',
      ...projectRecords(records, 'entry')
    },
    history: {
      updated: now, demo: false, timezone: 'Asia/Taipei',
      notice: '僅保存成功擷取的 Apple 官方價格；每天每個市場／型號／容量一筆，不補造缺失日期。',
      ...projectRecords(records, 'points')
    }
  };
}
