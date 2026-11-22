import { readJson } from './request.mjs';

export const MAX_SNAPSHOT_BYTES = 1_250_000;
const RETENTION_DAYS = 14;
const encoder = new TextEncoder();
const tables = {
  students: ['id', 'code', 'name', 'name_key', 'class_name', 'balance', 'created_at', 'parent_code'],
  lessons: ['id', 'student_id', 'lesson_date', 'active', 'created_at', 'voided_at'],
  audit_log: ['id', 'student_id', 'action', 'description', 'created_at'],
};
const safeId = /^[A-Za-z0-9_-]{1,80}$/;
const parentCode = /^[A-F0-9]{16}$/;
const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const date = /^\d{4}-\d{2}-\d{2}$/;

const bounded = (value, length) => typeof value === 'string' && value.length > 0 && value.length <= length;
const goodStamp = value => typeof value === 'string' && stamp.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const goodDate = value => typeof value === 'string' && date.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export async function exportSnapshot(db) {
  const results = await db.batch(Object.entries(tables).map(([table, columns]) =>
    db.prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY created_at, id`),
  ));
  return {
    format: 'yibiyihua-business-v1',
    exportedAt: new Date().toISOString(),
    ...Object.fromEntries(Object.keys(tables).map((table, index) => [table, results[index].results])),
  };
}

function validate(snapshot) {
  if (snapshot?.format !== 'yibiyihua-business-v1' || !goodStamp(snapshot.exportedAt)) return false;
  if (!Object.keys(tables).every(table => Array.isArray(snapshot[table]))) return false;
  const keys = new Set();
  for (const row of snapshot.students) {
    if (!row || typeof row.id !== 'string' || !safeId.test(row.id) || keys.has(row.id) ||
        !bounded(row.code, 40) || typeof row.parent_code !== 'string' || !parentCode.test(row.parent_code) ||
        !bounded(row.name, 30) || row.name.trim().replace(/\s+/g, '') !== row.name_key ||
        !bounded(row.class_name, 40) || !Number.isInteger(row.balance) || row.balance < 0 ||
        row.balance > 9999 || !goodStamp(row.created_at)) return false;
    keys.add(row.id);
  }
  for (const row of snapshot.lessons) {
    if (!row || typeof row.id !== 'string' || !safeId.test(row.id) || !keys.has(row.student_id) ||
        !goodDate(row.lesson_date) || !goodStamp(row.created_at) ||
        !((row.active === 1 && row.voided_at === null) || (row.active === 0 && goodStamp(row.voided_at)))) return false;
  }
  return snapshot.audit_log.every(row => row && bounded(row.id, 90) &&
    (row.student_id === null || keys.has(row.student_id)) &&
    bounded(row.action, 40) && bounded(row.description, 500) && goodStamp(row.created_at));
}

export async function restoreSnapshot(request, db) {
  const snapshot = await readJson(request, MAX_SNAPSHOT_BYTES);
  if (!validate(snapshot)) return { status: 400, error: '备份格式或内容无效。' };

  const inserts = Object.entries(tables).map(([table, columns]) => {
    const fields = columns.map(column => `json_extract(value, '$.${column}')`).join(', ');
    return db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) SELECT ${fields} FROM json_each(?)`)
      .bind(JSON.stringify(snapshot[table]));
  });
  try {
    await db.batch([
      db.prepare(`INSERT INTO restore_guard (id)
        SELECT CASE WHEN EXISTS (SELECT 1 FROM students) OR EXISTS (SELECT 1 FROM lessons)
          OR EXISTS (SELECT 1 FROM audit_log) THEN 0 ELSE 1 END`),
      ...inserts,
      db.prepare('DELETE FROM restore_guard WHERE id = 1'),
    ]);
  } catch (error) {
    if (/CHECK constraint failed.*id\s*=\s*1/i.test(String(error))) {
      return { status: 409, error: '恢复仅可在空数据库中执行，现有资料保持原样。' };
    }
    if (/constraint failed/i.test(String(error))) return { status: 400, error: '备份存在重复记录或不一致的数据。' };
    throw error;
  }
  return { status: 200, restored: snapshot.students.length };
}

async function backupKey(hex) {
  if (typeof hex !== 'string' || !/^[a-f\d]{64}$/i.test(hex)) throw new Error('BACKUP_KEY is missing or invalid');
  const bytes = Uint8Array.from(hex.match(/../g), pair => Number.parseInt(pair, 16));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function saveScheduledBackup(env, scheduledAt) {
  const key = await backupKey(env.BACKUP_KEY);
  const day = scheduledAt.toISOString().slice(0, 10);
  const snapshot = encoder.encode(JSON.stringify(await exportSnapshot(env.DB)));
  if (snapshot.byteLength > MAX_SNAPSHOT_BYTES) throw new Error('Backup exceeds the supported snapshot size');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(day) }, key, snapshot);
  const cutoff = new Date(scheduledAt.valueOf() - (RETENTION_DAYS - 1) * 86400_000).toISOString().slice(0, 10);
  await env.BACKUPS.batch([
    env.BACKUPS.prepare('INSERT INTO snapshots (date,nonce,ciphertext) VALUES (?,?,?) ON CONFLICT(date) DO NOTHING')
      .bind(day, Array.from(iv, byte => byte.toString(16).padStart(2, '0')).join(''), ciphertext),
    env.BACKUPS.prepare('DELETE FROM snapshots WHERE date < ?').bind(cutoff),
  ]);
}

export async function readScheduledBackup(env, day) {
  if (!goodDate(day)) return null;
  const row = await env.BACKUPS.prepare('SELECT nonce,ciphertext FROM snapshots WHERE date=?').bind(day).first();
  if (!row) return null;
  const iv = Uint8Array.from(row.nonce.match(/../g), byte => Number.parseInt(byte, 16));
  const key = await backupKey(env.BACKUP_KEY);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(day) }, key, Uint8Array.from(row.ciphertext));
}
