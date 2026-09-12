import {readFile, writeFile, mkdir, rename} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve, dirname} from 'node:path';
import {parseArgs} from 'node:util';
import {CURRENCIES, exchangeSourceUrl, parseExchangeRate, mergeExchangeRates, rejectRegressingRates} from './exchange-state.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pause = ms => new Promise(done => setTimeout(done, ms));
async function requestRate(currency, fetchImpl, wait, now) {
  const sourceUrl = exchangeSourceUrl(currency);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Bound the query to the same UTC calendar used by date validation.
      // Keep the provider's returned date (including previous business days).
      const date = new Date(now()).toISOString().slice(0, 10);
      const response = await fetchImpl(`${sourceUrl}?date=${date}`, {
        headers: {'Accept': 'application/json', 'User-Agent': 'iPhonePriceObserver/1.0'},
        signal: AbortSignal.timeout(20000), redirect: 'error'
      });
      if (!response.ok) throw new Error(`Frankfurter HTTP ${response.status}`);
      const body = await response.text();
      if (body.length > 10000) throw new Error('Unexpected response size');
      return {...parseExchangeRate(JSON.parse(body), currency, now()), currency};
    } catch (error) {
      if (attempt === 1) throw error;
      await wait(1500);
    }
  }
}
export async function collectExchangeRates({currencies = CURRENCIES, fetchImpl = fetch, pause: wait = pause,
  now = () => new Date().toISOString()} = {}) {
  let observations = [];
  let failures = [];
  for (const currency of currencies) {
    try {
      observations = [...observations, await requestRate(currency, fetchImpl, wait, now)];
    } catch (error) {
      failures = [...failures, {currency, sourceUrl: exchangeSourceUrl(currency), error: String(error.message).slice(0, 240)}];
    }
    await wait(250);
  }
  return {observations, failures};
}
async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
async function atomicJson(path, value) {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}
export async function main(args = process.argv.slice(2), {root = ROOT, collect = collectExchangeRates} = {}) {
  const {values} = parseArgs({args, options: {
    'output-dir': {type: 'string'}, report: {type: 'string'}, 'dry-run': {type: 'boolean', default: false}
  }});
  const output = resolve(values['output-dir'] ?? resolve(root, 'data'));
  const [previousRates, previousHistory] = await Promise.all([
    readJson(resolve(output, 'exchange-rates.json')), readJson(resolve(output, 'exchange-history.json'))
  ]);
  const collected = await collect();
  const now = new Date().toISOString();
  const result = rejectRegressingRates({previousRates, ...collected, now});
  const merged = mergeExchangeRates({previousRates, previousHistory, ...result, now});
  const report = {updated: now, source: 'frankfurter', successCount: result.observations.length,
    failureCount: result.failures.length, failures: result.failures, dryRun: values['dry-run']};
  // Retain partial successes and explicit stale/unavailable states even on failed runs.
  if (!values['dry-run']) {
    await atomicJson(resolve(output, 'exchange-rates.json'), merged.rates);
    await atomicJson(resolve(output, 'exchange-history.json'), merged.history);
  }
  if (values.report) await atomicJson(resolve(values.report), report);
  console.log(JSON.stringify(report, null, 2));
  return report.failureCount ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`Exchange rate update failed: ${error.message}`);
    process.exitCode = 1;
  });
}
