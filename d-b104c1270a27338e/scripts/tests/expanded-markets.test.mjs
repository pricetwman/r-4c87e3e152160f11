import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {collectPrices} from '../update-prices.mjs';
import {mergeObservations} from '../price-state.mjs';
import {CURRENCIES} from '../exchange-state.mjs';
const countries=JSON.parse(await readFile(new URL('../../data/countries.json',import.meta.url)));
const expected={TR:'TRY',PH:'PHP',NZ:'NZD',CH:'CHF',NL:'EUR',IE:'EUR',GR:'EUR',PT:'EUR',EG:'EGP',BR:'BRL',MX:'MXN'};
test('all eleven requested markets have matching currencies and official Apple destinations',()=>{
 for(const [code,currency] of Object.entries(expected)) {
  assert.equal(countries[code]?.currency,currency);
  assert.ok(CURRENCIES.includes(currency));
  assert.equal(new URL(countries[code].appleUrl).hostname,'www.apple.com');
 }
 assert.equal(countries.CH.appleUrl,'https://www.apple.com/ch-de/shop/buy-iphone');
 for(const code of ['GR','EG']) assert.equal(countries[code].directSales,false);
});
test('reseller-only markets make no requests, cause no failed run and publish no invented prices',async()=>{
 const products={'iphone-16':{name:'iPhone 16',storage:['128GB']}};
 const markets=[{code:'GR',currency:'EUR',base:'https://www.apple.com/gr/buy/',directSales:false}];
 let calls=0;
 const result=await collectPrices({products,markets,fetchImpl:async()=>{calls++;throw new Error('must not request');},pause:async()=>{}});
 assert.equal(calls,0);assert.deepEqual(result.failures,[]);
 const merged=mergeObservations({products,markets,...result,previousPrices:{},previousHistory:{},now:'2026-09-12T01:00:00Z'});
 const entry=merged.prices['iphone-16']['128GB'].GR;
 assert.equal(entry.price,null);assert.equal(entry.checkedAt,null);
 assert.equal(entry.status,'unavailable');assert.equal(entry.sourceUrl,markets[0].base);
 assert.match(entry.error,/direct/i);
 assert.deepEqual(merged.history['iphone-16']['128GB'].GR,[]);
});
test('mixing reseller-only and direct markets still collects the direct store once',async()=>{
 const html=await readFile(new URL('./fixtures/tw-iphone-16.html',import.meta.url),'utf8');
 const products={'iphone-16':{name:'iPhone 16',storage:['128GB']}};
 const markets=[{code:'GR',currency:'EUR',base:'https://www.apple.com/gr/buy/',directSales:false},
  {code:'TW',currency:'TWD',base:'https://www.apple.com/tw/shop/buy-iphone'}];
 const urls=[];
 const result=await collectPrices({products,markets,pause:async()=>{},fetchImpl:async url=>{
  urls.push(url);return new Response(html);
 }});
 assert.deepEqual(urls,['https://www.apple.com/tw/shop/buy-iphone/iphone-16']);
 assert.equal(result.observations.length,1);assert.deepEqual(result.failures,[]);
});
