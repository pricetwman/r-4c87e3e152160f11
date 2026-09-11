import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseApplePrices} from '../apple-parser.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/new-markets.json', import.meta.url)));
const products = Object.fromEntries([
  ['iphone-18-pro', 'iPhone 18 Pro'],
  ['iphone-18-pro-max', 'iPhone 18 Pro Max'],
  ['iphone-duo', 'iPhone Duo']
].map(([id, name]) => [id, {name, storage: ['256GB', '512GB', '1TB', '2TB']}]));
// Captured official full prices, in Pro / Pro Max / Duo and capacity order.
const expected = {
  KR: [1990000,2290000,2890000,3790000,2190000,2490000,3090000,3990000,3290000,3590000,4190000,5090000],
  TH: [48900,56900,72900,96900,52900,60900,76900,100900,79900,87900,103900,127900],
  MY: [5499,6499,8499,11499,5999,6999,8999,11999,9499,10499,12499,15499],
  CA: [1749,2049,2649,3549,1899,2199,2799,3699,2999,3299,3899,4799],
  GB: [1199,1399,1799,2399,1299,1499,1899,2499,1999,2199,2599,3199],
  DE: [1449,1699,2199,2949,1599,1849,2349,3099,2299,2549,3049,3799],
  FR: [1479,1729,2229,2979,1629,1879,2379,3129,2339,2589,3089,3839],
  AE: [5099,5949,7649,10199,5499,6349,8049,10599,8499,9349,11049,13599]
};
const parse = (entry, metrics = entry.metrics) => parseApplePrices(
  `<script id="metrics" type="application/json">${JSON.stringify({data: metrics})}</script>`,
  {market: entry.market, page: entry.page, products}
);

for (const [code, prices] of Object.entries(expected)) {
  test(`${code} captured official prices cover every model and capacity without mixing currencies`, () => {
    const entries = fixture.pages.filter(entry => entry.market.code === code);
    assert.equal(entries.length, 2);
    const results = entries.map(entry => parse(entry));
    assert.deepEqual(results.flatMap(result => result.failures), []);
    const observations = results.flatMap(result => result.observations);
    assert.deepEqual(observations.map(row => row.price), prices);
    assert.equal(new Set(observations.map(row => `${row.model}/${row.storage}`)).size, 12);
    for (const entry of entries) {
      const result = parse(entry);
      assert.ok(result.observations.every(row => row.currency === entry.market.currency));
      assert.ok(result.observations.every(row => row.sourceUrl === `${entry.market.base}/${entry.page.slug}`));
      assert.throws(() => parse(entry, {...entry.metrics, currency: 'USD'}), /Currency/);
    }
  });
}

test('regional metrics fail closed when full retail prices disappear or color prices disagree', () => {
  for (const entry of fixture.pages) {
    const noFullPrice = {...entry.metrics, products: entry.metrics.products.map(row => ({
      ...row, price: {monthlyPrice: row.price.fullPrice / 24, tradeInPrice: row.price.fullPrice / 2}
    }))};
    assert.equal(parse(entry, noFullPrice).observations.length, 0);
    const conflictingColor = {...entry.metrics, products: entry.metrics.products.map((row, index) =>
      index === 0 ? {...row, price: {fullPrice: row.price.fullPrice + 1}} : row)};
    const result = parse(entry, conflictingColor);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].error, /Color\/SKU prices disagree/);
  }
});

test('European product prices stay separate even when their currencies are identical', () => {
  const german = fixture.pages.find(entry => entry.market.code === 'DE');
  const french = fixture.pages.find(entry => entry.market.code === 'FR');
  assert.equal(german.market.currency, french.market.currency);
  assert.notEqual(parse(german).observations[0].price, parse(french).observations[0].price);
  assert.notEqual(parse(german).observations[0].sourceUrl, parse(french).observations[0].sourceUrl);
});
