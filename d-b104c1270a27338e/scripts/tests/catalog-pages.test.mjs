import test from 'node:test';
import assert from 'node:assert/strict';
import {collectPrices} from '../update-prices.mjs';
import {mergeObservations} from '../price-state.mjs';
import {parseApplePrices} from '../apple-parser.mjs';
const products = {'iphone-17': {name: 'iPhone 17', storage: ['256GB']},
  'iphone-16': {name: 'iPhone 16', storage: ['128GB']}};
const market = {code: 'TW', currency: 'TWD', base: 'https://www.apple.com/tw/shop/buy-iphone'};
test('daily collection visits configured newer and older product pages only', async () => {
  const urls = [];
  const result = await collectPrices({products, markets: [market], pause: async () => {}, fetchImpl: async url => {
    urls.push(url);
    return new Response('<script id="metrics">{"data":{"currency":"TWD","products":[]}}</script>');
  }});
  assert.deepEqual(urls, [market.base+'/iphone-17',market.base+'/iphone-16']);
  assert.equal(result.failures.length, 2);
});
test('missing older model prices retain their own official source URLs', () => {
  const result = mergeObservations({products, markets: [market], observations: [], failures: [],
    previousPrices: {}, previousHistory: {}, now: '2026-09-11T14:00:00Z'});
  assert.equal(result.prices['iphone-16']['128GB'].TW.sourceUrl, market.base+'/iphone-16');
  assert.equal(result.prices['iphone-17']['256GB'].TW.sourceUrl, market.base+'/iphone-17');
});
test('US standalone anchors verify four added models and still reject carrier discounts', () => {
  const market = {code:'US',currency:'USD',base:'https://www.apple.com/shop/buy-iphone'};
  for (const [id,name,size,storage] of [['iphone-17','iPhone 17','6.3','256GB'],
    ['iphone-17e','iPhone 17e','6.1','256GB'],['iphone-air','iPhone Air','6.5','256GB'],['iphone-16','iPhone 16','6.1','128GB']]) {
    const metrics = `<script id="metrics">${JSON.stringify({data:{currency:'USD',products:[{name:`${name} ${storage} Black`,category:'iphone',sku:'TEST',partNumber:'TEST/A',price:{fullPrice:829}}]}})}</script>`;
    const options = {market,page:{slug:id,models:[id]},products:{[id]:{name,storage:[storage]}}};
    const anchor = amount => `<a href="${market.base}/${id}/${size}-inch-display-${storage.toLowerCase()}-black-unlocked"><span class="current_price">$${amount}.00</span></a>`;
    assert.equal(parseApplePrices(metrics+anchor(829),options).observations.length,1,id);
    assert.equal(parseApplePrices(metrics+anchor(799),options).observations.length,0,id);
  }
});
test('shared shop slugs collect once while retaining all models and leaving catalog unchanged', async () => {
  const products = {'iphone-18-pro':{name:'iPhone 18 Pro',storage:['256GB']},
    'iphone-18-pro-max':{name:'iPhone 18 Pro Max',storage:['256GB']},
    'iphone-16':{name:'iPhone 16',storage:['128GB'],appleSlug:'iphone-16'},
    'iphone-16-plus':{name:'iPhone 16 Plus',storage:['128GB'],appleSlug:'iphone-16'}};
  const before=JSON.stringify(products);
  const urls=[];
  const result=await collectPrices({products,markets:[market],pause:async()=>{},fetchImpl:async url=>{
    urls.push(url);
    return new Response('<script id="metrics">{"data":{"currency":"TWD","products":[]}}</script>');
  }});
  assert.deepEqual(urls,[market.base+'/iphone-18-pro',market.base+'/iphone-16']);
  assert.deepEqual(result.failures.map(row=>row.model),Object.keys(products));
  assert.equal(JSON.stringify(products),before);
});
test('invalid configured product slug is rejected before any fetch',async()=>{
  for(const appleSlug of ['../iphone-16','https://example.com/iphone-16','iphone-16?discount=1']){
    await assert.rejects(()=>collectPrices({products:{'iphone-16':{name:'iPhone 16',storage:['128GB'],appleSlug}},
      markets:[market],fetchImpl:async()=>assert.fail('Invalid source must not be requested')}),/Invalid Apple product page slug/);
  }
});
