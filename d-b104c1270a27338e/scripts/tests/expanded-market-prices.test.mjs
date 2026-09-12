import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {catalogPages} from '../catalog-pages.mjs';
import {parseApplePrices} from '../apple-parser.mjs';
const json=async path=>JSON.parse(await readFile(new URL(path,import.meta.url)));
const [captures,products,countries,prices,history]=await Promise.all([
 json('./fixtures/expanded-markets.json'),json('../../data/products.json'),json('../../data/countries.json'),
 json('../../data/prices.json'),json('../../data/price-history.json')]);
const codes=['TR','PH','NZ','CH','NL','IE','PT','BR','MX'];
const pages=catalogPages(products);
for(const code of codes) {
 test(`${code} captured official metrics verify all twenty product capacities`,()=>{
  const market={code,currency:countries[code].currency,base:countries[code].appleUrl};
  const captured=captures.filter(item=>item.sourceUrl.startsWith(`${market.base}/`));
  assert.equal(captured.length,6);
  const observations=captured.flatMap(item=>{
   const page=pages.find(entry=>item.sourceUrl===`${market.base}/${entry.slug}`);
   assert.ok(page);
   const parse=metrics=>parseApplePrices(`<script id="metrics">${JSON.stringify({data:metrics})}</script>`,{market,page,products});
   const result=parse(item.metrics);
   assert.deepEqual(result.failures,[]);
   assert.throws(()=>parse({...item.metrics,currency:'INVALID'}),/Currency/);
   assert.equal(parse({...item.metrics,products:item.metrics.products.map(row=>({...row,
    price:{monthlyPrice:row.price.fullPrice/24,tradeInPrice:row.price.fullPrice/2}}))}).observations.length,0);
   return result.observations;
  });
  assert.equal(observations.length,20);
  assert.equal(new Set(observations.map(row=>`${row.model}/${row.storage}`)).size,20);
  for(const row of observations) {
   const entry=prices[row.model][row.storage][code];
   assert.ok(Number.isFinite(entry.price)&&entry.price>0);
   assert.equal(entry.sourceUrl,row.sourceUrl);assert.equal(entry.currency,row.currency);
   assert.ok(history[row.model][row.storage][code].some(point=>point.checkedAt===entry.checkedAt&&point.price===entry.price));
  }
 });
}
test('reseller-only countries remain selectable without fabricated prices or history',()=>{
 for(const code of ['GR','EG']) for(const [model,product] of Object.entries(products)) for(const storage of product.storage) {
  const entry=prices[model][storage][code];
  assert.equal(entry.price,null);assert.equal(entry.status,'unavailable');assert.equal(entry.checkedAt,null);
  assert.deepEqual(history[model][storage][code],[]);
 }
});
