import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ISSUE_MARKER = '<!-- iphone-price-daily-update-health:v1 -->';
const WORKFLOW_NAME = 'Update Apple prices daily';
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required', 'stale']);
const loginPattern = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
const clean = value => String(value ?? '').replace(/@/g, '@\u200b')
  .replace(/[<>`\[\]\\]/g, '').replace(/\s+/g, ' ').slice(0, 400);

function trustedRun(event) {
  const run = event?.workflow_run;
  const repo = event?.repository;
  return event?.action === 'completed' && /^[\w.-]+\/[\w.-]+$/.test(repo?.full_name ?? '')
    && run?.name === WORKFLOW_NAME && run.head_branch === repo.default_branch
    && run.head_repository?.full_name === repo.full_name
    && ['schedule', 'workflow_dispatch'].includes(run.event) && run.status === 'completed'
    && Number.isSafeInteger(run.id) && run.id > 0
    && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0
    && (run.conclusion === 'success' || FAILED.has(run.conclusion));
}

export function githubRequest(token, fetchImpl = fetch) {
  if (!token) throw new Error('Missing GitHub notification token');
  return async (method, path, body) => {
    if (!path.startsWith('/repos/')) throw new Error('Unsupported GitHub API path');
    const response = await fetchImpl(`https://api.github.com${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000), redirect: 'error'
    });
    if (!response.ok) throw new Error(`GitHub API ${method} failed (${response.status})`);
    return response.status === 204 ? null : response.json();
  };
}

export async function readReport(path) {
  try {
    if ((await stat(path)).size > 1000000) return null;
    const report = JSON.parse(await readFile(path, 'utf8'));
    return Number.isSafeInteger(report?.failureCount) && report.failureCount >= 0
      && Array.isArray(report.failures) ? report : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function reportSection(title, report) {
  if (!report || !Array.isArray(report.failures)) return `### ${title}\n未取得更新報告，請查看執行紀錄。`;
  const failures = report.failures.slice(0, 40).map(item => {
    const key = [item?.country, item?.model, item?.storage, item?.currency].filter(Boolean).map(clean).join(' / ').slice(0, 160);
    return `- ${key || '未知項目'}：${clean(item?.error).slice(0, 320) || '更新失敗'}`;
  });
  const extra = report.failures.length > 40 ? '\n僅列前 40 筆；完整清單見該次執行的 update-reports 附件。' : '';
  return `### ${title}\n失敗 ${clean(report.failureCount)} 筆。\n${failures.join('\n')}${extra}`;
}

function notificationBody(event, jobs, reports) {
  const run = event.workflow_run;
  const link = `https://github.com/${event.repository.full_name}/actions/runs/${run.id}/attempts/${run.run_attempt}`;
  const header = `${ISSUE_MARKER}\n[查看更新執行紀錄](${link})\n\n執行結果：${clean(run.conclusion)}。`;
  if (run.conclusion === 'success') return `${header}\n\n每日更新已恢復正常，本通知自動結案。`;
  const failedJobs = jobs.filter(job => FAILED.has(job.conclusion)).map(job => {
    const steps = (job.steps ?? []).filter(step => FAILED.has(step.conclusion)).slice(0, 3)
      .map(step => clean(step.name).slice(0, 120));
    return `- ${clean(job.name).slice(0, 120)}：${clean(job.conclusion)}${steps.length ? `（${steps.join('、')}）` : ''}`;
  }).slice(0, 20);
  return `${header}\n\n${failedJobs.join('\n') || '工作未完成，請查看執行紀錄。'}\n\n`
    + `${reportSection('Apple 官方售價', reports.prices)}\n\n${reportSection('參考匯率', reports.exchange)}\n\n`
    + '此 Issue 會持續更新最新失敗狀態；下一次更新成功後自動關閉。';
}

async function notificationIssue(request, base) {
  for (let page = 1; ; page++) {
    const issues = await request('GET', `${base}/issues?state=open&per_page=100&page=${page}`);
    const found = issues.find(item => !item.pull_request && item.user?.login === 'github-actions[bot]'
      && item.body?.startsWith(ISSUE_MARKER));
    if (found || issues.length < 100) return found;
  }
}

async function runJobs(request, base, run) {
  let jobs = [];
  for (let page = 1; ; page++) {
    const result = await request('GET', `${base}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`);
    jobs = [...jobs, ...result.jobs];
    if (result.jobs.length < 100) return jobs;
  }
}

export async function syncNotification({ event, request, reports = {}, assignee }) {
  if (!trustedRun(event)) return 'ignored';
  const run = event.workflow_run;
  const repo = event.repository;
  const base = `/repos/${repo.full_name}`;
  const latest = await request('GET', `${base}/actions/workflows/update-prices.yml/runs?branch=${encodeURIComponent(repo.default_branch)}&status=completed&per_page=100`);
  const current = latest.workflow_runs.find(item => ['schedule', 'workflow_dispatch'].includes(item.event));
  if (current?.id !== run.id || current.run_attempt !== run.run_attempt || current.conclusion !== run.conclusion) return 'outdated';
  const existing = await notificationIssue(request, base);
  if (run.conclusion === 'success' && !existing) return 'healthy';
  const jobs = run.conclusion === 'success' ? [] : await runJobs(request, base, run);
  const body = notificationBody(event, jobs, reports);
  if (existing) {
    await request('PATCH', `${base}/issues/${existing.number}`, { body,
      ...(run.conclusion === 'success' ? { state: 'closed', state_reason: 'completed' } : {}) });
    return run.conclusion === 'success' ? 'closed' : 'updated';
  }
  const recipient = assignee || (repo.owner?.type === 'User' ? repo.owner.login : null);
  if (recipient && !loginPattern.test(recipient)) throw new Error('Invalid notification assignee');
  await request('POST', `${base}/issues`, { title: '每日 iPhone 價格更新失敗', body,
    ...(recipient ? { assignees: [recipient] } : {}) });
  return 'created';
}

export async function main(env = process.env, { request } = {}) {
  if (!env.GITHUB_EVENT_PATH || env.GITHUB_EVENT_NAME !== 'workflow_run') throw new Error('Expected workflow_run event');
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  const reportDir = env.UPDATE_REPORT_DIR || 'update-reports';
  const [prices, exchange] = await Promise.all([
    readReport(resolve(reportDir, 'update-report.json')), readReport(resolve(reportDir, 'exchange-report.json'))
  ]);
  const result = await syncNotification({ event, reports: { prices, exchange },
    assignee: env.UPDATE_NOTIFICATION_ASSIGNEE, request: request ?? githubRequest(env.GITHUB_TOKEN) });
  console.log(`Update notification: ${result}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Update notification failed: ${error.message}`); process.exitCode = 1; });
}
