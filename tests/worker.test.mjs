import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const temp = await mkdtemp(join(tmpdir(), 'yibiyihua-worker-'));
const wrangler = process.platform === 'win32' ? 'node_modules/.bin/wrangler.cmd' : 'node_modules/.bin/wrangler';
const setupKey = 'test-only-bootstrap-phrase-not-a-secret';
const backupKey = 'a0'.repeat(32);
const credentials = { username: 'test-teacher', password: 'synthetic-password-only' };
const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const clients = [];
let checks = 0;

function expect(value, message) {
  assert.ok(value, message);
  checks++;
}

async function start(port, state, apply = true) {
  const origin = `http://127.0.0.1:${port}`;
  const dir = join(temp, state);
  if (apply) {
    for (const binding of ['DB', 'BACKUPS']) {
      const migration = spawnSync(wrangler, ['d1', 'migrations', 'apply', binding, '--local', '--persist-to', dir], {
        encoding: 'utf8',
        env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
      });
      assert.equal(migration.status, 0, migration.stderr || migration.stdout);
    }
  }
  const child = spawn(wrangler, [
    'dev', '--local', '--persist-to', dir, '--ip', '127.0.0.1', '--port', String(port),
    '--inspector-port', '0', '--test-scheduled', '--var', `ADMIN_SETUP_KEY:${setupKey}`, '--var', `BACKUP_KEY:${backupKey}`,
  ], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await done;
  };
  clients.push(stop);
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error(logs);
    try {
      const response = await fetch(origin + '/api/status');
      assert.equal(response.status, 200, logs);
      break;
    } catch (error) {
      if (attempt === 79) throw new Error(logs, { cause: error });
      await delay(250);
    }
  }
  let cookie;
  async function call(path, data, options = {}) {
    const headers = { origin, ...options.headers };
    if (data !== undefined) headers['content-type'] = 'application/json';
    if (cookie && options.auth !== false) headers.cookie = cookie;
    const response = await fetch(origin + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers,
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, body };
  }
  return { call, stop, logs: () => logs };
}

const setup = { ...credentials, confirmPassword: credentials.password, setupKey };

try {
  let primary = await start(18787, 'primary');
  const home = await primary.call('/');
  expect(home.status === 200 && home.body.includes('家长查询码'), 'Parent page');
  const admin = await primary.call('/admin');
  expect(admin.status === 200 && admin.body.includes('管理后台'), 'Admin page');
  expect((await primary.call('/demo')).status === 404, 'Demo page unavailable');
  expect((await primary.call('/api/setup', { ...setup, setupKey: '' })).status === 403, 'No anonymous setup');
  expect((await primary.call('/api/setup', setup)).status === 201, 'Secret-gated setup');
  expect((await primary.call('/api/admin/students', undefined, { auth: false })).status === 401, 'No anonymous roster');
  const created = await primary.call('/api/admin/students', { name: '验收甲', group: '测试', balance: 4 });
  expect(created.status === 201 && created.body.student.parentCode.length === 16, 'Synthetic student and query code');
  const student = created.body.student;
  const lookup = { name: student.name, code: student.parentCode };
  expect((await primary.call('/api/search', { name: student.name })).status === 400, 'Name alone cannot retrieve data');
  const initial = await primary.call('/api/search', lookup, { auth: false });
  expect(initial.body.students[0].balance === 4, 'Unauthenticated parent with correct code');
  const lesson = { id: student.id, date, requestId: 'worker-check-lesson1', expectedCount: 0 };
  expect((await primary.call('/api/admin/lesson', lesson)).body.student.balance === 3, 'Lesson decrements balance');
  expect((await primary.call('/api/admin/lesson', lesson)).body.student.balance === 3, 'Retry retains balance');
  const parent = await primary.call('/api/search', lookup, { auth: false });
  expect(parent.body.students[0].balance === 3 && parent.body.students[0].records[0].date === date, 'Fresh parent view sees updated calendar');
  expect((await primary.call('/api/admin/lesson/undo', { id: student.id, lessonId: lesson.requestId })).body.student.balance === 4, 'Undo restores one class');
  expect((await primary.call('/api/admin/lesson', { ...lesson, requestId: 'worker-check-lesson2' })).status === 201, 'Can record a new lesson');
  const backup = await primary.call('/api/admin/export');
  expect(backup.status === 200 && backup.body.lessons.length === 2 && backup.body.lessons.some(r => r.active === 0), 'Snapshot preserves voided lessons');
  expect((await primary.call('/api/admin/restore', backup.body)).status === 409, 'Restore protects nonempty database');
  const cron = await primary.call('/__scheduled?cron=0+19+*+*+*');
  expect(cron.status === 200, primary.logs());
  const dates = await primary.call('/api/admin/backups');
  expect(dates.body.dates.length === 1, 'Scheduled encrypted snapshot was saved');
  const scheduled = await primary.call('/api/admin/backup?date=' + dates.body.dates[0]);
  expect(scheduled.status === 200 && scheduled.body.lessons.length === 2, 'Scheduled snapshot decrypted');
  expect((await primary.call('/api/admin/backup?date=' + dates.body.dates[0], undefined, { auth: false })).status === 401, 'Scheduled snapshot requires admin');
  await primary.stop();
  primary = await start(18787, 'primary', false);
  expect((await primary.call('/api/search', lookup)).body.students[0].balance === 3, 'Balance persists through worker restart');
  const recovery = await start(18788, 'isolated-recovery');
  expect((await recovery.call('/api/search', lookup)).body.students.length === 0, 'New database starts isolated');
  expect((await recovery.call('/api/setup', setup)).status === 201, 'Recovery database has separate authentication');
  const restore = await recovery.call('/api/admin/restore', scheduled.body);
  expect(restore.status === 200 && restore.body.restored === 1, 'Encrypted backup can be restored');
  const recovered = await recovery.call('/api/admin/export');
  for (const table of ['students', 'lessons', 'audit_log']) assert.deepEqual(recovered.body[table], backup.body[table]);
  checks++;
  const restoredParent = await recovery.call('/api/search', lookup, { auth: false });
  expect(restoredParent.body.students[0].balance === 3 && restoredParent.body.students[0].records.length === 1, 'Restored parent data and ledger are consistent');
  console.log(`PASS: ${checks} local Cloudflare Worker/D1 checks.`);
} finally {
  for (const stop of clients.reverse()) await stop();
  await rm(temp, { recursive: true, force: true });
}
