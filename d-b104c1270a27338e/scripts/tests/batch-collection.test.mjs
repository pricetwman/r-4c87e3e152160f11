import test from 'node:test';
import assert from 'node:assert/strict';
import {collectPrices} from '../update-prices.mjs';
const products = {'iphone-17':{name:'iPhone 17',storage:['256GB']},'iphone-16':{name:'iPhone 16',storage:['128GB']}};
const markets = Array.from({length:7},(_,index)=>({code:`M${index}`,currency:'TWD',base:`https://www.apple.com/m${index}/shop/buy-iphone`}));
const html = `<script id="metrics">${JSON.stringify({data:{currency:'TWD',products:[
  {name:'iPhone 17 256GB Black',category:'iphone',sku:'X',partNumber:'X/A',price:{fullPrice:32900}},
  {name:'iPhone 16 128GB Black',category:'iphone',sku:'Y',partNumber:'Y/A',price:{fullPrice:29900}}
]}})}</script>`;
test('serial batches wait five seconds per page and two minutes every three countries',async()=>{
  const events=[];
  const result=await collectPrices({products,markets,pause:async ms=>events.push(ms),fetchImpl:async url=>{
    events.push(url);return new Response(html);
  }});
  assert.equal(result.observations.length,14);
  assert.equal(result.failures.length,0);
  assert.equal(typeof events[0],'string');
  assert.equal(typeof events.at(-1),'string');
  const waits=events.filter(event=>typeof event==='number');
  assert.deepEqual(waits,Array.from({length:13},(_,index)=>(index+1)%6===0?120000:5000));
});
for(const status of [403,429]) test(`HTTP ${status} stops all further Apple requests and records untouched variants`,async()=>{
  let requests=0;
  const result=await collectPrices({products,markets,pause:async()=>{},fetchImpl:async()=>{
    requests+=1;return requests===1?new Response(html):new Response('stop',{status});
  }});
  assert.equal(requests,2);
  assert.equal(result.observations.length,1);
  assert.equal(result.failures.length,13);
  assert.ok(result.failures.every(row=>row.error.includes(String(status))));
  assert.match(result.failures.at(-1).error,/not requested/);
});
test('temporary server errors back off for 15 and 30 seconds before recovering',async()=>{
  let requests=0;const waits=[];
  const result=await collectPrices({products:{'iphone-17':products['iphone-17']},markets:markets.slice(0,1),
    pause:async ms=>waits.push(ms),fetchImpl:async()=>++requests<3?new Response('unavailable',{status:503}):new Response(html)});
  assert.equal(result.observations.length,1);
  assert.deepEqual(waits,[15000,30000]);
});
test('server-requested cooldown stops the run instead of retrying before Retry-After',async()=>{
  let requests=0;
  const result=await collectPrices({products,markets,pause:async()=>{},fetchImpl:async()=>{
    requests+=1;return new Response('cooldown',{status:503,headers:{'Retry-After':'3600'}});
  }});
  assert.equal(requests,1);
  assert.equal(result.failures.length,14);
});
