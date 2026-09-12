import {readFile, writeFile, mkdir, rename} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve, dirname} from 'node:path';
import {parseArgs} from 'node:util';
import {parseApplePrices} from './apple-parser.mjs';
import {mergeObservations} from './price-state.mjs';
import {catalogPages} from './catalog-pages.mjs';

const COUNTRIES_PER_BATCH = 3;
const REQUEST_DELAY_MS = 5000;
const BATCH_DELAY_MS = 30000;
const RECOVERY_BATCH_DELAY_MS = 120000;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pause = ms => new Promise(done => setTimeout(done, ms));
const permitted = url => ['www.apple.com', 'www.apple.com.cn'].includes(url.hostname) &&
  url.protocol === 'https:' && !url.username && !url.password && !url.port;

class AppleResponseError extends Error {
  constructor(response) {
    const cooldown = response.headers.get('retry-after');
    super(`Apple HTTP ${response.status}${cooldown ? '; server requested cooldown' : ''}`);
    this.status = response.status;
    this.stopCollection = [403, 429].includes(response.status) || (response.status === 503 && Boolean(cooldown));
  }
}

async function requestPage(url, fetchImpl, wait, onRequestError) {
  if (!permitted(new URL(url))) throw new Error('Untrusted source URL');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: {
          'User-Agent': 'iPhonePriceObserver/1.0 (daily official retail price research)',
          'Accept': 'text/html'
        },
        signal: AbortSignal.timeout(30000), redirect: 'error'
      });
      if (!response.ok) throw new AppleResponseError(response);
      const text = await response.text();
      if (text.length > 15000000) throw new Error('Unexpected page size');
      return text;
    } catch (error) {
      onRequestError();
      if (attempt === 2 || error.stopCollection || (error.status >= 400 && error.status < 500)) throw error;
      await wait(15000 * (attempt + 1));
    }
  }
}

function pageFailures({page, products, market, sourceUrl, error}) {
  return page.models.flatMap(model => products[model].storage.map(storage => ({
    model, storage, country: market.code, currency: market.currency, sourceUrl,
    error: String(error.message).slice(0, 240)
  })));
}

export async function collectPrices({products, markets, pages = catalogPages(products), fetchImpl = fetch,
  pause: wait = pause, onProgress = () => {}}) {
  const directMarkets = markets.filter(market => market.directSales !== false);
  const tasks = directMarkets.flatMap((market, marketIndex) => pages.map((page, pageIndex) => ({
    market, page, batch: Math.floor(marketIndex / COUNTRIES_PER_BATCH),
    batchStart: marketIndex % COUNTRIES_PER_BATCH === 0 && pageIndex === 0,
    sourceUrl: `${market.base}/${page.slug}`
  })));
  let observations = [];
  let failures = [];
  let stopped = null;
  let batchHadError = false;
  for (const [index, task] of tasks.entries()) {
    if (stopped) {
      failures = [...failures, ...pageFailures({...task, products,
        error: new Error(`Collection stopped after ${stopped}; this page was not requested`)})];
      continue;
    }
    if (index > 0) {
      const cooldown = batchHadError ? RECOVERY_BATCH_DELAY_MS : BATCH_DELAY_MS;
      await wait(task.batchStart ? cooldown : REQUEST_DELAY_MS);
    }
    if (task.batchStart) batchHadError = false;
    if (task.batchStart) onProgress(`Apple batch ${task.batch + 1}/${Math.ceil(directMarkets.length / COUNTRIES_PER_BATCH)}: ${directMarkets
      .slice(task.batch * COUNTRIES_PER_BATCH, (task.batch + 1) * COUNTRIES_PER_BATCH).map(market => market.code).join(', ')}`);
    try {
      const html = await requestPage(task.sourceUrl, fetchImpl, wait, () => { batchHadError = true; });
      const result = parseApplePrices(html, {market: task.market, page: task.page, products});
      if (result.failures.length > 0) batchHadError = true;
      const checkedAt = new Date().toISOString();
      observations = [...observations, ...result.observations.map(item => ({...item, checkedAt}))];
      failures = [...failures, ...result.failures];
    } catch (error) {
      batchHadError = true;
      failures = [...failures, ...pageFailures({...task, products, error})];
      if (error.stopCollection) {
        stopped = error.message;
        onProgress(`Stopping Apple collection: ${stopped}`);
      }
    }
  }
  return {observations, failures};
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

async function readInputs(root, output) {
  const data = resolve(root, 'data');
  const [products, countries, previousPrices, previousHistory] = await Promise.all([
    readJson(resolve(data, 'products.json')),
    readJson(resolve(data, 'countries.json')),
    readJson(resolve(output, 'prices.json'), {}),
    readJson(resolve(output, 'price-history.json'), {})
  ]);
  const markets = Object.entries(countries).map(([code, country]) => ({
    code, currency: country.currency, base: country.appleUrl, directSales: country.directSales !== false
  }));
  return {products, markets, previousPrices, previousHistory};
}

export async function main(args = process.argv.slice(2), {root = ROOT, collect = collectPrices} = {}) {
  const {values} = parseArgs({args, options: {
    'output-dir': {type: 'string'}, report: {type: 'string'},
    'dry-run': {type: 'boolean', default: false}
  }});
  const output = resolve(values['output-dir'] ?? resolve(root, 'data'));
  const inputs = await readInputs(root, output);
  const result = await collect({products: inputs.products, markets: inputs.markets, onProgress: message => console.log(message)});
  const now = new Date().toISOString();
  const merged = mergeObservations({...inputs, ...result, now});
  const report = {
    updated: now, successCount: result.observations.length,
    failureCount: result.failures.length, failures: result.failures,
    dryRun: values['dry-run']
  };
  // Persist partial successes and stale flags before reporting a failed job.
  if (!values['dry-run']) {
    await atomicJson(resolve(output, 'prices.json'), merged.prices);
    await atomicJson(resolve(output, 'price-history.json'), merged.history);
  }
  if (values.report) await atomicJson(resolve(values.report), report);
  console.log(JSON.stringify(report, null, 2));
  return report.failureCount ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`Price update failed: ${error.message}`);
    process.exitCode = 1;
  });
}
