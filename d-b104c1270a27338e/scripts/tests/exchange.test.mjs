import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseExchangeRate, mergeExchangeRates, exchangeSourceUrl} from '../exchange-state.mjs';
import {collectExchangeRates, main} from '../update-exchange-rates.mjs';
const now = '2026-09-11T12:00:00.000Z';
const payload = {date:'2026-09-11',base:'USD',quote:'TWD',rate:31.579};
const observation = parse => ({currency:'USD', ...parseExchangeRate(parse ?? payload, 'USD', now)});
const merge = (overrides={}) => mergeExchangeRates({currencies:['USD'], previousRates:{}, previousHistory:{}, observations:[observation()], failures:[], now, ...overrides});
test('valid direct pair preserves quote direction and source date', () => {
 const record=observation(); assert.equal(record.rate,31.579); assert.equal(record.date,'2026-09-11');
 assert.equal(record.sourceUrl,exchangeSourceUrl('USD')); assert.equal(record.checkedAt,now);
});
test('rejects invalid amounts, currency, dates, stale or future provider data', () => {
 for (const patch of [{rate:0},{rate:-1},{rate:NaN},{rate:Infinity},{rate:'31'},{base:'EUR'},{quote:'USD'},
  {date:'2026-02-31'},{date:'2026-09-12'},{date:'2026-09-03'},{date:'2026-9-11'},{date:null}]) {
  assert.throws(()=>parseExchangeRate({...payload,...patch},'USD',now));
 }
 assert.throws(()=>parseExchangeRate(null,'USD',now));
 assert.throws(()=>parseExchangeRate(payload,'XXX',now));
 assert.throws(()=>parseExchangeRate(payload,'USD','invalid'));
 assert.equal(observation({...payload,date:'2026-09-04'}).date,'2026-09-04');
});
test('removes all DEMO data and initializes only real observations',()=>{
 const result=merge({previousRates:{demo:true,rates:{USD:1}}, previousHistory:{demo:true,USD:[{date:'2026-09-10',rate:1}]}});
 assert.equal(result.rates.demo,false); assert.equal(result.rates.rates.TWD,1); assert.equal(result.rates.rates.USD,31.579);
 assert.equal(result.rates.status,'current'); assert.equal(result.rates.updated,payload.date); assert.equal(result.history.USD.length,1);
 assert.deepEqual(result.history.TWD,[]);
});
test('failed refresh retains real rate and check time, flags stale, adds no history',()=>{
 const initial=merge(); const frozen=JSON.stringify(initial);
 const next=merge({previousRates:initial.rates,previousHistory:initial.history,observations:[],failures:[{currency:'USD',error:'timeout'}],now:'2026-09-12T12:00:00.000Z'});
 assert.equal(next.rates.records.USD.status,'stale'); assert.equal(next.rates.records.USD.checkedAt,now);
 assert.equal(next.rates.status,'stale'); assert.equal(next.rates.records.USD.error,'timeout');
 assert.deepEqual(next.history.USD,initial.history.USD); assert.equal(JSON.stringify(initial),frozen);
});
test('same provider date replaces point on weekend without invented observation dates',()=>{
 const initial=merge();
 const next=merge({previousRates:initial.rates,previousHistory:initial.history,now:'2026-09-12T12:00:00.000Z',observations:[observation({...payload,rate:32})]});
 assert.equal(next.history.USD.length,1); assert.equal(next.history.USD[0].date,'2026-09-11'); assert.equal(next.history.USD[0].rate,32);
 const later=merge({previousRates:next.rates,previousHistory:next.history,now:'2026-09-14T12:00:00.000Z',observations:[{...observation(),date:'2026-09-14',checkedAt:'2026-09-14T12:00:00.000Z'}]});
 assert.equal(later.history.USD.length,2);
});
test('invalid real-container records and history never carry forward',()=>{
 const initial=merge();
 for(const patch of [{source:'demo'},{rate:-1},{sourceUrl:'https://evil.test'},{date:'2026-02-31'},{checkedAt:'2027-01-01T00:00:00Z'}, {date:'2026-09-12'}, {checkedAt:null}]) {
  const bad={...initial.rates.records.USD,...patch};
  const result=merge({observations:[],previousRates:{demo:false,records:{USD:bad}},previousHistory:{demo:false,USD:[bad]}});
  assert.equal(result.rates.rates.USD,null); assert.equal(result.rates.status,'unavailable'); assert.equal(result.history.USD.length,0);
 }
 const empty=merge({observations:[]}); assert.equal(empty.rates.updated,undefined); assert.equal(empty.rates.checkedAt,null);
});
test('global date uses oldest currency observation and ignores failed new input',()=>{
 const result=merge({currencies:['USD','JPY'], observations:[observation(),{...observation(),currency:'JPY',date:'2026-09-10',sourceUrl:exchangeSourceUrl('JPY'),rate:0.21}]});
 assert.equal(result.rates.updated,'2026-09-10');
 assert.throws(()=>merge({observations:[{...observation(),rate:0}]}));
});
test('collector retries transient failures and isolates failed pairs',async()=>{
 let count=0;
 const result=await collectExchangeRates({currencies:['USD','JPY'],now:()=>now,pause:async()=>{},fetchImpl:async url=>{
  count++; if(url.includes('/JPY/')) return new Response('no',{status:503});
  return new Response(JSON.stringify(payload));
 }});
 assert.equal(count,3); assert.equal(result.observations.length,1); assert.equal(result.failures.length,1);
 let attempts=0;
 const retry=await collectExchangeRates({currencies:['USD'],now:()=>now,pause:async()=>{},fetchImpl:async()=>{
  if(++attempts===1) throw new Error('network'); return new Response(JSON.stringify(payload));
 }}); assert.equal(retry.failures.length,0); assert.equal(attempts,2);
 const bad=await collectExchangeRates({currencies:['USD'],now:()=>now,pause:async()=>{},fetchImpl:async()=>new Response('{}')});
 assert.equal(bad.failures.length,1);
});
test('CLI persists data and report before failure, dry-run does not write data',async()=>{
 const output=await mkdtemp(join(tmpdir(),'exchange-test-'));
 try {
  const report=join(output,'report.json');
  const collect=async()=>({observations:[{...observation(),checkedAt:new Date().toISOString()}],failures:[{currency:'JPY',error:'timeout'}]});
  assert.equal(await main(['--output-dir',output,'--report',report],{collect}),1);
  const before=await readFile(join(output,'exchange-rates.json'),'utf8');
  assert.equal(JSON.parse(before).rates.USD,31.579); assert.equal(JSON.parse(await readFile(report)).failureCount,1);
  assert.equal(await main(['--output-dir',output,'--dry-run'],{collect:async()=>({observations:[],failures:[]})}),0);
  assert.equal(await readFile(join(output,'exchange-rates.json'),'utf8'),before);
  await writeFile(join(output,'exchange-rates.json'),'{bad');
  await assert.rejects(()=>main(['--output-dir',output],{collect}));
 } finally {await rm(output,{recursive:true,force:true});}
});
test('provider date regression retains newer verified current value and reports failure',async()=>{
 const output=await mkdtemp(join(tmpdir(),'exchange-regression-'));
 try {
  const initial=merge();
  await writeFile(join(output,'exchange-rates.json'),JSON.stringify(initial.rates));
  await writeFile(join(output,'exchange-history.json'),JSON.stringify(initial.history));
  const report=join(output,'report.json');
  const collect=async()=>({observations:[{...observation(),date:'2026-09-10',rate:30}],failures:[]});
  assert.equal(await main(['--output-dir',output,'--report',report],{collect}),1);
  const rates=JSON.parse(await readFile(join(output,'exchange-rates.json')));
  const history=JSON.parse(await readFile(join(output,'exchange-history.json')));
  assert.equal(rates.records.USD.status,'stale'); assert.equal(rates.records.USD.rate,31.579);
  assert.deepEqual(history.USD,initial.history.USD);
  const audit=JSON.parse(await readFile(report)); assert.equal(audit.failureCount,1); assert.equal(audit.successCount,0);
 } finally {await rm(output,{recursive:true,force:true});}
});
