import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseApplePrices} from '../apple-parser.mjs';

const readData = async name => JSON.parse(await readFile(new URL(`../../data/${name}.json`, import.meta.url)));
const [products, countries, prices, history] = await Promise.all(
  ['products', 'countries', 'prices', 'price-history'].map(readData)
);
const catalog = {
  'iphone-17': {storage: ['256GB', '512GB'], TW: [32900, 39900], US: [929, 1129]},
  'iphone-17e': {storage: ['256GB', '512GB'], TW: [25900, 32900], US: [699, 899]},
  'iphone-air': {storage: ['256GB', '512GB', '1TB'], TW: [39900, 46900, 61900], US: [1099, 1299, 1699]},
  'iphone-16': {storage: ['128GB'], TW: [29900], US: [829]}
};

for (const [model, expected] of Object.entries(catalog)) {
  const fixtures = Object.fromEntries(await Promise.all(['TW', 'US'].map(async code => [code,
    await readFile(new URL(`./fixtures/${code.toLowerCase()}-${model}.html`, import.meta.url), 'utf8')
  ])));
  const parse = (code, html = fixtures[code]) => parseApplePrices(html, {
    market: {code, currency: countries[code].currency, base: countries[code].appleUrl},
    page: {slug: model, models: [model]}, products
  });

  test(`${model} catalog capacities and TW/US captured official full prices agree`, () => {
    assert.deepEqual(products[model].storage, expected.storage);
    for (const code of ['TW', 'US']) {
      const result = parse(code);
      assert.deepEqual(result.failures, []);
      assert.deepEqual(result.observations.map(row => row.price), expected[code]);
      assert.deepEqual(result.observations.map(row => row.storage), expected.storage);
    }
    const image = new URL(products[model].image);
    assert.equal(image.protocol, 'https:');
    assert.equal(image.hostname, 'store.storeimages.cdn-apple.com');
    assert.equal(products[model].imageSourceUrl, `${countries.TW.appleUrl}/${model}`);
  });

  test(`${model} refuses US carrier-only selectors and amounts that disagree with metrics`, () => {
    const carrierOnly = fixtures.US.replaceAll('-unlocked', '-att');
    assert.equal(parse('US', carrierOnly).observations.length, 0);
    const mismatched = fixtures.US.replace(/(<span\b[^>]*class="current_price"[^>]*>\s*)\$[\d,]+\.\d{2}/g, (_match, opening) => `${opening}$1.00`);
    assert.notEqual(mismatched, fixtures.US);
    assert.equal(parse('US', mismatched).observations.length, 0);
  });

  test(`${model} publishes official records and real history for every configured market`, () => {
    for (const storage of expected.storage) {
      assert.deepEqual(Object.keys(prices[model][storage]).sort(), Object.keys(countries).sort());
      for (const [code, country] of Object.entries(countries)) {
        const entry = prices[model][storage][code];
        assert.equal(entry.source, 'apple');
        assert.equal(entry.currency, country.currency);
        assert.equal(entry.sourceUrl, `${country.appleUrl}/${model}`);
        assert.ok(['current', 'stale', 'unavailable'].includes(entry.status));
        const points = history[model][storage][code];
        if (entry.status === 'unavailable') {
          assert.equal(entry.price, null);
          assert.equal(entry.checkedAt, null);
          continue;
        }
        assert.ok(Number.isFinite(entry.price) && entry.price > 0);
        assert.ok(points.some(point => point.price === entry.price && point.checkedAt === entry.checkedAt));
        assert.ok(points.every(point => point.source === 'apple' && point.sourceUrl === entry.sourceUrl && point.currency === entry.currency));
      }
    }
  });
}
