import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseApplePrices} from '../apple-parser.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/vietnam-india.json', import.meta.url)));
const products = JSON.parse(await readFile(new URL('../../data/products.json', import.meta.url)));
const prices = JSON.parse(await readFile(new URL('../../data/prices.json', import.meta.url)));
const history = JSON.parse(await readFile(new URL('../../data/price-history.json', import.meta.url)));
const expected = {
  VN: [38999000,45499000,58499000,77999000,41999000,48499000,61499000,80999000,64999000,71499000,84499000,103999000],
  IN: [164900,189900,239900,314900,179900,204900,254900,329900,299900,324900,374900,449900]
};
const parse = (entry, metrics = entry.metrics) => parseApplePrices(
  `<script id="metrics" type="application/json">${JSON.stringify({data: metrics})}</script>`,
  {market: entry.market, page: entry.page, products}
);

for (const [code, amounts] of Object.entries(expected)) {
  test(`${code} official full prices match all twelve variants and reject wrong currencies`, () => {
    const entries = fixture.pages.filter(entry => entry.market.code === code);
    assert.equal(entries.length, 2);
    const results = entries.map(entry => parse(entry));
    assert.deepEqual(results.flatMap(result => result.failures), []);
    const observations = results.flatMap(result => result.observations);
    assert.deepEqual(observations.map(row => row.price), amounts);
    assert.equal(new Set(observations.map(row => `${row.model}/${row.storage}`)).size, 12);
    for (const entry of entries) {
      assert.ok(parse(entry).observations.every(row => row.currency === entry.market.currency));
      assert.throws(() => parse(entry, {...entry.metrics, currency: 'USD'}), /Currency/);
    }
  });

  test(`${code} published variants have official prices and matching history`, () => {
    for (const entry of fixture.pages.filter(entry => entry.market.code === code)) {
      for (const observed of parse(entry).observations) {
        const current = prices[observed.model][observed.storage][code];
        assert.ok(current, `${observed.model}/${observed.storage}/${code} must be present`);
        assert.ok(Number.isFinite(current.price) && current.price > 0);
        assert.equal(current.currency, observed.currency);
        assert.equal(current.sourceUrl, observed.sourceUrl);
        assert.equal(current.source, 'apple');
        assert.ok(['current', 'stale'].includes(current.status));
        const points = history[observed.model][observed.storage][code];
        assert.ok(points.some(point => point.checkedAt === current.checkedAt && point.price === current.price));
      }
    }
  });
}

test('Vietnam and India do not accept monthly or trade-in prices as retail full prices', () => {
  for (const entry of fixture.pages) {
    const metrics = {...entry.metrics, products: entry.metrics.products.map(row => ({
      ...row, price: {monthlyPrice: row.price.fullPrice / 24, tradeInPrice: row.price.fullPrice / 2}
    }))};
    assert.equal(parse(entry, metrics).observations.length, 0);
  }
});
