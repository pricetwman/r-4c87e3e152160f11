import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {CURRENCIES} from '../exchange-state.mjs';
import {main} from '../update-prices.mjs';

const countries = JSON.parse(await readFile(new URL('../../data/countries.json', import.meta.url)));
const added = ['KR', 'TH', 'MY', 'CA', 'GB', 'DE', 'FR', 'AE', 'VN', 'IN'];

test('popular markets have official regional sources and matching FX coverage', () => {
  for (const code of added) {
    assert.ok(countries[code], `Missing market ${code}`);
    assert.ok(CURRENCIES.includes(countries[code].currency), `Missing FX ${code}`);
    const url = new URL(countries[code].appleUrl);
    assert.equal(url.origin, 'https://www.apple.com');
    assert.ok(url.pathname.endsWith('/shop/buy-iphone'));
  }
  assert.equal(new Set(CURRENCIES).size, CURRENCIES.length);
  assert.equal(countries.GB.appleUrl, 'https://www.apple.com/uk/shop/buy-iphone');
});

test('daily price updater passes every configured market to the collector', async () => {
  let observed;
  await main(['--dry-run'], {collect: async ({markets}) => {
    observed = markets;
    return {observations: [], failures: []};
  }});
  assert.deepEqual(observed.map(market => market.code), Object.keys(countries));
  for (const market of observed) {
    assert.equal(market.base, countries[market.code].appleUrl);
    assert.equal(market.currency, countries[market.code].currency);
  }
});
