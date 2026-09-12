export const CURRENCIES = Object.freeze([
  'USD', 'JPY', 'HKD', 'SGD', 'CNY', 'AUD',
  'KRW', 'THB', 'MYR', 'CAD', 'GBP', 'EUR', 'AED', 'VND', 'INR',
  'TRY', 'PHP', 'NZD', 'CHF', 'EGP', 'BRL', 'MXN'
]);
const DAY = 86400000;
const SOURCE = 'https://frankfurter.dev/';
export function exchangeSourceUrl(currency) {
  if (!CURRENCIES.includes(currency)) throw new Error('Unsupported currency');
  return `https://api.frankfurter.dev/v2/rate/${currency}/TWD`;
}
function dateTime(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date ? parsed : NaN;
}
function validRecord(record, currency, now) {
  const day = dateTime(record?.date);
  const checked = typeof record?.checkedAt === 'string' ? Date.parse(record.checkedAt) : NaN;
  return record?.source === 'frankfurter' && record.sourceUrl === exchangeSourceUrl(currency) &&
    Number.isFinite(record.rate) && record.rate > 0 && Number.isFinite(day) &&
    Number.isFinite(checked) && checked <= Date.parse(now) && day <= checked && day <= Date.parse(now);
}
export function parseExchangeRate(payload, currency, checkedAt) {
  const sourceUrl = exchangeSourceUrl(currency);
  const checked = Date.parse(checkedAt);
  const date = dateTime(payload?.date);
  const today = Number.isFinite(checked) ? dateTime(new Date(checked).toISOString().slice(0, 10)) : NaN;
  if (payload?.base !== currency || payload.quote !== 'TWD' ||
      !Number.isFinite(payload.rate) || payload.rate <= 0 || !Number.isFinite(date) ||
      !Number.isFinite(today) || date > today || today - date > 7 * DAY) {
    throw new Error(`Invalid or outdated ${currency}/TWD reference rate`);
  }
  return {rate: payload.rate, date: payload.date, checkedAt, source: 'frankfurter', sourceUrl};
}
export function rejectRegressingRates({previousRates, observations, failures, now}) {
  const regressed = observations.filter(item => {
    const old = previousRates.demo === false ? previousRates.records?.[item.currency] : null;
    return validRecord(old, item.currency, now) && item.date < old.date;
  });
  return {
    observations: observations.filter(item => !regressed.includes(item)),
    failures: [...failures, ...regressed.map(item => ({
      currency: item.currency, sourceUrl: exchangeSourceUrl(item.currency),
      error: 'Provider date regressed; retaining newer verified reference rate'
    }))]
  };
}
function buildCurrency(context, currency) {
  const {previousRates, previousHistory, observations, failures, now} = context;
  const found = observations.find(item => item.currency === currency);
  if (found && !validRecord(found, currency, now)) throw new Error(`Invalid observation for ${currency}`);
  const old = previousRates.demo === false ? previousRates.records?.[currency] : null;
  const failure = failures.find(item => item.currency === currency);
  const error = String(failure?.error ?? 'No successful reference rate observation').slice(0, 240);
  const retained = previousHistory.demo === false && Array.isArray(previousHistory[currency]) ?
    previousHistory[currency].filter(point => validRecord(point, currency, now)) : [];
  const entry = found ? {
    rate: found.rate, date: found.date, checkedAt: found.checkedAt,
    source: 'frankfurter', sourceUrl: exchangeSourceUrl(currency), status: 'current', lastAttemptAt: now
  } : validRecord(old, currency, now) ? {...old, status: 'stale', lastAttemptAt: now, error} : {
    rate: null, date: null, checkedAt: null, source: 'frankfurter',
    sourceUrl: exchangeSourceUrl(currency), status: 'unavailable', lastAttemptAt: now, error
  };
  const points = found ? [...retained.filter(point => point.date !== found.date), {
    date: found.date, rate: found.rate, checkedAt: found.checkedAt,
    source: 'frankfurter', sourceUrl: exchangeSourceUrl(currency)
  }] : retained;
  const history = [...new Map(points.map(point => [point.date, point])).values()]
    .sort((a, b) => a.date.localeCompare(b.date));
  return [currency, {entry, history}];
}
export function mergeExchangeRates(context) {
  const {now, currencies = CURRENCIES} = context;
  if (!Number.isFinite(Date.parse(now))) throw new Error('Invalid collection time');
  const verified = {...context, ...rejectRegressingRates(context)};
  const entries = currencies.map(currency => buildCurrency(verified, currency));
  const records = Object.fromEntries(entries.map(([currency, value]) => [currency, value.entry]));
  const successful = Object.values(records).filter(record => record.rate !== null);
  const updated = successful.map(record => record.date).sort()[0];
  const checkedAt = successful.map(record => record.checkedAt).sort()[0] ?? null;
  const statuses = Object.values(records).map(record => record.status);
  const status = statuses.includes('unavailable') ? 'unavailable' : statuses.includes('stale') ? 'stale' : 'current';
  return {
    rates: {
      ...(updated ? {updated} : {}), checkedAt, lastAttemptAt: now, demo: false, base: 'TWD',
      source: 'frankfurter', sourceUrl: SOURCE, status,
      notice: 'Frankfurter 彙整央行每日參考匯率；1 單位外幣折合新台幣，非銀行現鈔或信用卡成交匯率。',
      rates: {TWD: 1, ...Object.fromEntries(entries.map(([currency, value]) => [currency, value.entry.rate]))},
      records: {TWD: {rate: 1, date: now.slice(0, 10), checkedAt: now, status: 'current', source: 'identity', sourceUrl: null}, ...records}
    },
    history: {
      ...(updated ? {updated} : {}), demo: false, source: 'frankfurter', sourceUrl: SOURCE,
      notice: '僅保存成功取得的每日參考匯率，以提供者資料日期去重；不補造週末、假日或缺失日期。',
      TWD: [], ...Object.fromEntries(entries.map(([currency, value]) => [currency, value.history]))
    }
  };
}
