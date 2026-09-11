import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApplePrices } from '../apple-parser.mjs';
import { mergeObservations, taipeiDate } from '../price-state.mjs';
import { collectPrices } from '../update-prices.mjs';
const products = { 'iphone-18-pro': {name:'iPhone 18 Pro',storage:['256GB','512GB']} };
const market = {code:'TW',currency:'TWD',base:'https://www.apple.com/tw/shop/buy-iphone'};
const page = {slug:'iphone-18-pro',models:['iphone-18-pro']};
const item = (capacity='256GB',price=44900,color='Black') => ({name:`iPhone 18 Pro ${capacity} ${color}`,category:'iphone',sku:'ABC12',partNumber:'ABC12ZP/A',price:{fullPrice:price}});
const html = (items=[item(),item('512GB',51900)],currency='TWD',extra='') => `<script type="application/json" id="metrics">${JSON.stringify({data:{currency,products:items}})}</script>${extra}`;
const parse = (body,region=market) => parseApplePrices(body,{market:region,page,products});
const now='2026-09-11T18:30:00.000Z';
const observation = {model:'iphone-18-pro',storage:'256GB',country:'TW',price:44900,currency:'TWD',sourceUrl:market.base+'/iphone-18-pro'};
const merge = (overrides={}) => mergeObservations({products,markets:[market],previousPrices:{},previousHistory:{},observations:[observation],failures:[],now,...overrides});
test('parses fullPrice, normalized spaces, capacities and consistent colors',()=>{
 const result=parse(html([item(),item('256GB',44900,'Silver'),item('512GB',51900)]));
 assert.equal(result.observations.length,2); assert.equal(result.observations[0].price,44900); assert.equal(result.failures.length,0);
});
test('never accepts wrong currency, absent metrics or invalid JSON',()=>{
 for(const body of [html(undefined,'USD'),'<html>blocked</html>','<script id="metrics">{bad}</script>']) assert.throws(()=>parse(body));
});
test('missing variant and inconsistent colors are explicit failures',()=>{
 const result=parse(html([item(),item('256GB',45000,'Silver')]));
 assert.equal(result.observations.length,0); assert.equal(result.failures.length,2);
});
test('rejects monthly values, malformed identity, no SKU and invalid fullPrice',()=>{
 const cases=[{...item(),price:{monthlyPrice:1200}},{...item(),name:'iPhone 18 Pro Max 256GB Black'},{...item(),sku:null},{...item(),price:{fullPrice:-1}}];
 for(const bad of cases) assert.equal(parse(html([bad])).observations.length,0);
});
test('US requires matching unlocked standalone visible price, rejecting promo mismatch',()=>{
 const us={...market,code:'US',currency:'USD',base:'https://www.apple.com/shop/buy-iphone'};
 const anchor=(p)=>`<a href="${us.base}/iphone-18-pro/6.3-inch-display-256gb-black-unlocked"><span class="current_price">$${p}.00</span></a>`;
 assert.equal(parse(html([item('256GB',1199)],'USD',anchor(1199)),us).observations.length,1);
 assert.equal(parse(html([item('256GB',1199)],'USD',anchor(999)),us).observations.length,0);
 assert.equal(parse(html([item('256GB',1199)],'USD'),us).observations.length,0);
});
test('Taipei observation date crosses UTC midnight correctly',()=>assert.equal(taipeiDate(now),'2026-09-12'));
test('DEMO prices and history are discarded, only successful real history added',()=>{
 const previousPrices={demo:true,'iphone-18-pro':{'512GB':{TW:{price:51900,source:'demo'}}}};
 const previousHistory={demo:true,'iphone-18-pro':{'256GB':{TW:[{date:'2025-01-01',price:1}]}}};
 const result=merge({previousPrices,previousHistory});
 assert.equal(result.prices.demo,false); assert.equal(result.history.demo,false);
 assert.equal(result.prices['iphone-18-pro']['512GB'].TW.price,null);
 assert.equal(result.history['iphone-18-pro']['256GB'].TW.length,1);
 assert.equal(result.history['iphone-18-pro']['512GB'].TW.length,0);
});
test('failure retains verified previous real price as stale without fabricating history',()=>{
 const initial=merge();
 const result=merge({previousPrices:initial.prices,previousHistory:initial.history,observations:[],now:'2026-09-13T00:00:00Z'});
 assert.equal(result.prices['iphone-18-pro']['256GB'].TW.status,'stale');
 assert.equal(result.prices['iphone-18-pro']['256GB'].TW.checkedAt,now);
 assert.deepEqual(result.history['iphone-18-pro']['256GB'].TW,initial.history['iphone-18-pro']['256GB'].TW);
});
test('same Taipei date rerun replaces sample, later day appends, inputs immutable',()=>{
 const initial=merge(); const original=JSON.stringify(initial);
 const result=merge({previousPrices:initial.prices,previousHistory:initial.history,observations:[{...observation,price:45000}]});
 assert.equal(result.history['iphone-18-pro']['256GB'].TW.length,1);
 assert.equal(result.history['iphone-18-pro']['256GB'].TW[0].price,45000);
 assert.equal(JSON.stringify(initial),original);
 const later=merge({previousPrices:result.prices,previousHistory:result.history,now:'2026-09-13T00:00:00Z'});
 assert.equal(later.history['iphone-18-pro']['256GB'].TW.length,2);
});
test('unverified historic records do not cross into live, even in demo:false container',()=>{
 const result=merge({previousHistory:{demo:false,'iphone-18-pro':{'256GB':{TW:[{date:'2025-01-01',price:1,source:'demo'}]}}}});
 assert.equal(result.history['iphone-18-pro']['256GB'].TW.length,1);
});
test('collector uses injected fetch and reports HTTP/parser failures independently',async()=>{
 const result=await collectPrices({products,markets:[market],pages:[page],fetchImpl:async()=>new Response(html()),pause:async()=>{}});
 assert.equal(result.observations.length,2); assert.equal(result.failures.length,0);
 const failed=await collectPrices({products,markets:[market],pages:[page],fetchImpl:async()=>new Response('blocked',{status:403}),pause:async()=>{}});
 assert.equal(failed.observations.length,0); assert.equal(failed.failures.length,2);
});

test('captured Apple Taiwan and US page excerpts validate all actual model prices',async()=>{
 const {readFile}=await import('node:fs/promises');
 const catalog=JSON.parse(await readFile(new URL('../../data/products.json',import.meta.url)));
 for(const [fixture,code,currency,slug,models] of [
  ['tw-pro','TW','TWD','iphone-18-pro',['iphone-18-pro','iphone-18-pro-max']],
  ['us-pro','US','USD','iphone-18-pro',['iphone-18-pro','iphone-18-pro-max']],
  ['us-duo','US','USD','iphone-duo',['iphone-duo']]]){
   const body=await readFile(new URL(`./fixtures/${fixture}.html`,import.meta.url),'utf8');
   const result=parseApplePrices(body,{market:{...market,code,currency,base:code==='US'?'https://www.apple.com/shop/buy-iphone':market.base},page:{slug,models},products:catalog});
   assert.deepEqual(result.failures,[]);
   assert.equal(result.observations.length,models.reduce((total,id)=>total+catalog[id].storage.length,0));
 }
});
test('CLI writes partial report and data before returning nonzero; dry run leaves data intact',async()=>{
 const {mkdtemp,mkdir,writeFile,readFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
 const {main}=await import('../update-prices.mjs');
 const root=await mkdtemp(join(tmpdir(),'apple-prices-test-'));
 try{
  await mkdir(join(root,'data'));
  await writeFile(join(root,'data/products.json'),JSON.stringify(products));
  await writeFile(join(root,'data/countries.json'),JSON.stringify(Object.fromEntries(['TW','JP','US','HK','SG','CN','AU'].map(code=>[code,{currency:'TWD',appleUrl:market.base}]))));
  const collect=async()=>({observations:[observation],failures:[{...observation,storage:'512GB',error:'missing'}]});
  const report=join(root,'report.json');
  assert.equal(await main(['--report',report],{root,collect}),1);
  const current=await readFile(join(root,'data/prices.json'),'utf8');
  assert.equal(JSON.parse(current)['iphone-18-pro']['256GB'].TW.status,'current');
  assert.equal(JSON.parse(await readFile(report)).failureCount,1);
  assert.equal(await main(['--dry-run'],{root,collect:async()=>({observations:[],failures:[]})}),0);
  assert.equal(await readFile(join(root,'data/prices.json'),'utf8'),current);
 } finally{await rm(root,{recursive:true,force:true});}
});
test('rejects future checks, impossible calendar dates and mismatched history day',()=>{
 const valid={...observation,source:'apple',checkedAt:now,date:'2026-09-12'};
 const previousHistory={demo:false,'iphone-18-pro':{'256GB':{TW:[
  {...valid,date:'2026-02-31',checkedAt:'2026-03-03T01:00:00Z'},
  {...valid,date:'2026-09-11'},
  {...valid,checkedAt:'2027-01-01T00:00:00Z'}
 ]}}};
 const previousPrices={demo:false,'iphone-18-pro':{'256GB':{TW:{...valid,checkedAt:'2027-01-01T00:00:00Z'}}}};
 const result=merge({previousHistory,previousPrices,observations:[]});
 assert.equal(result.history['iphone-18-pro']['256GB'].TW.length,0);
 assert.equal(result.prices['iphone-18-pro']['256GB'].TW.status,'unavailable');
});
test('midnight-spanning run stores each actual observation day and check time',()=>{
 const first={...observation,checkedAt:'2026-09-11T15:59:59.000Z'};
 const second={...observation,storage:'512GB',price:51900,checkedAt:'2026-09-11T16:00:01.000Z'};
 const result=merge({now:'2026-09-11T16:00:05.000Z',observations:[first,second]});
 assert.equal(result.prices['iphone-18-pro']['256GB'].TW.checkedAt,first.checkedAt);
 assert.equal(result.history['iphone-18-pro']['256GB'].TW[0].date,'2026-09-11');
 assert.equal(result.history['iphone-18-pro']['512GB'].TW[0].date,'2026-09-12');
 assert.equal(result.prices.observationDate,'2026-09-12');
});
