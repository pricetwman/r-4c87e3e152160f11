import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncNotification, ISSUE_MARKER, githubRequest, readReport, main } from '../update-notification.mjs';

const event = (conclusion = 'failure', extra = {}) => ({
  action: 'completed', repository: { full_name: 'pricetwman/iphone-price', default_branch: 'main',
    owner: { login: 'pricetwman', type: 'User' } },
  workflow_run: { id: 42, run_attempt: 1, workflow_id: 9, name: 'Update Apple prices daily',
    head_branch: 'main', head_repository: { full_name: 'pricetwman/iphone-price' },
    event: 'schedule', status: 'completed', conclusion, ...extra }
});
const issue = (extra = {}) => ({ number: 7, body: `${ISSUE_MARKER}\nPrevious failure`,
  user: { login: 'github-actions[bot]' }, ...extra });

function api({ issues = [], latest = event().workflow_run, jobs = [] } = {}) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.includes('/actions/workflows/')) return { workflow_runs: [latest] };
    if (path.includes('/jobs?')) return { jobs };
    if (method === 'GET' && path.includes('/issues?')) return issues;
    if (method === 'POST' || method === 'PATCH') return { number: 7 };
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  return { request, calls, writes: () => calls.filter(call => call.method !== 'GET') };
}

test('creates one assigned issue with exact affected price variants and currencies', async () => {
  const client = api({ jobs: [{ name: 'collection-status', conclusion: 'failure',
    steps: [{ name: 'Flag partial collection', conclusion: 'failure' }] }] });
  assert.equal(await syncNotification({ event: event(), request: client.request,
    reports: { prices: { failureCount: 1, failures: [{ country: 'JP', model: 'iphone-17', storage: '256GB', error: 'HTTP 429' }] },
      exchange: { failureCount: 1, failures: [{ currency: 'USD', error: 'Timeout' }] } } }), 'created');
  assert.equal(client.writes().length, 1);
  const body = client.writes()[0].body;
  assert.deepEqual(body.assignees, ['pricetwman']);
  for (const expected of ['JP', 'iphone-17', '256GB', 'USD', 'HTTP 429', 'collection-status', '/actions/runs/42']) {
    assert.ok(body.body.includes(expected), expected);
  }
});

test('repeated failures update the existing bot issue without creating comments', async () => {
  const client = api({ issues: [issue({ user: { login: 'some-user' } }), issue()] });
  assert.equal(await syncNotification({ event: event(), request: client.request }), 'updated');
  assert.equal(client.writes().length, 1);
  assert.match(client.writes()[0].path, /\/issues\/7$/);
  assert.equal(client.writes()[0].method, 'PATCH');
  assert.match(client.writes()[0].body.body, /未取得/);
});

test('recovery closes the existing notification; healthy first run creates nothing', async () => {
  const client = api({ issues: [issue()], latest: event('success').workflow_run });
  assert.equal(await syncNotification({ event: event('success'), request: client.request }), 'closed');
  assert.equal(client.writes()[0].body.state, 'closed');
  assert.equal(client.writes()[0].body.state_reason, 'completed');
  const fresh = api({ latest: event('success').workflow_run });
  assert.equal(await syncNotification({ event: event('success'), request: fresh.request }), 'healthy');
  assert.deepEqual(fresh.writes(), []);
});

test('timeout and cancellation still notify when the collector could not upload reports', async () => {
  for (const conclusion of ['timed_out', 'cancelled', 'startup_failure', 'action_required']) {
    const client = api({ latest: event(conclusion).workflow_run });
    assert.equal(await syncNotification({ event: event(conclusion), request: client.request }), 'created');
    assert.ok(client.writes()[0].body.body.includes(conclusion));
  }
});

test('untrusted branches, repositories, workflows and pull-request runs cannot mutate issues', async () => {
  for (const extra of [{ head_branch: 'feature' }, { head_repository: { full_name: 'other/fork' } },
    { event: 'pull_request' }, { name: 'Other workflow' }, { status: 'in_progress' }, { id: '../bad' },
    { conclusion: 'skipped' }]) {
    const client = api();
    assert.equal(await syncNotification({ event: event('failure', extra), request: client.request }), 'ignored');
    assert.deepEqual(client.calls, []);
  }
});

test('late events and old rerun attempts cannot overwrite newer health status', async () => {
  for (const latest of [event('success', { id: 43 }).workflow_run, event('success', { run_attempt: 2 }).workflow_run]) {
    const client = api({ latest });
    assert.equal(await syncNotification({ event: event(), request: client.request }), 'outdated');
    assert.deepEqual(client.writes(), []);
  }
});

test('notification output caps reports and neutralizes unwanted mentions/markup', async () => {
  const client = api();
  await syncNotification({ event: event(), request: client.request, assignee: 'admin-user', reports: {
    prices: { failureCount: 200, failures: Array.from({ length: 200 }, () => ({
      country: 'TW', error: '@everyone <img src=x>\n```evil'.repeat(100) })) }
  } });
  const body = client.writes()[0].body;
  assert.deepEqual(body.assignees, ['admin-user']);
  assert.ok(body.body.length < 60000);
  assert.ok(!body.body.includes('@everyone'));
  assert.ok(!body.body.includes('<img'));
  assert.match(body.body, /200/);
});

test('GitHub API failures propagate, omit credentials and never report notification success', async () => {
  const request = githubRequest('secret-token', async (url, options) => {
    assert.ok(url.startsWith('https://api.github.com/repos/'));
    assert.equal(options.headers.Authorization, 'Bearer secret-token');
    assert.equal(options.redirect, 'error');
    return { ok: false, status: 403, text: async () => 'secret-token error' };
  });
  await assert.rejects(request('GET', '/repos/a/b/issues'), /GitHub API GET failed \(403\)/);
});

test('missing or malformed report falls back to run status', async () => {
  assert.equal(await readReport('/not-present/update-report.json'), null);
  assert.equal(await readReport(new URL(import.meta.url)), null);
});

test('CLI reads the event and bounded JSON reports, without contacting a live API', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'iphone-notification-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'update-report.json');
  await writeFile(join(dir, 'event.json'), JSON.stringify(event()));
  await writeFile(path, JSON.stringify({ failureCount: 1, failures: [{ country: 'VN', error: 'Timeout' }] }));
  const client = api();
  await main({ GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: join(dir, 'event.json'),
    UPDATE_REPORT_DIR: dir }, { request: client.request });
  assert.match(client.writes()[0].body.body, /VN/);
  await writeFile(path, JSON.stringify({ failureCount: -1, failures: [] }));
  assert.equal(await readReport(path), null);
  await writeFile(path, ' '.repeat(1000001));
  assert.equal(await readReport(path), null);
  await assert.rejects(main({}), /Expected workflow_run/);
});

test('API transport serializes writes and returns JSON or empty success', async () => {
  assert.throws(() => githubRequest(''), /Missing/);
  const request = githubRequest('test-token', async (_, options) => {
    assert.deepEqual(JSON.parse(options.body), { state: 'closed' });
    return { ok: true, status: 200, json: async () => ({ number: 7 }) };
  });
  assert.deepEqual(await request('PATCH', '/repos/a/b/issues/7', { state: 'closed' }), { number: 7 });
  await assert.rejects(request('GET', 'https://example.com'), /Unsupported/);
  const empty = githubRequest('test-token', async () => ({ ok: true, status: 204 }));
  assert.equal(await empty('GET', '/repos/a/b/issues'), null);
});

test('deduplication searches later issue pages and aggregates later job pages', async () => {
  const writes = [];
  const request = async (method, path, body) => {
    if (method !== 'GET') { writes.push({ path, body }); return {}; }
    if (path.includes('/actions/workflows/')) return { workflow_runs: [event().workflow_run] };
    if (path.includes('/issues?')) return path.endsWith('page=1') ? Array.from({ length: 100 }, () => issue({ body: 'Unrelated' })) : [issue()];
    if (path.includes('/jobs?')) return { jobs: path.endsWith('page=1')
      ? Array.from({ length: 100 }, () => ({ conclusion: 'success' }))
      : [{ name: 'Later job failed', conclusion: 'failure' }] };
    throw new Error('Unexpected request');
  };
  assert.equal(await syncNotification({ event: event(), request }), 'updated');
  assert.equal(writes.length, 1);
  assert.match(writes[0].body.body, /Later job failed/);
});

test('assignee validation prevents an invalid setting from being submitted', async () => {
  const client = api();
  await assert.rejects(syncNotification({ event: event(), request: client.request, assignee: 'bad user' }), /Invalid/);
  assert.deepEqual(client.writes(), []);
});
