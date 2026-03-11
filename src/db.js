/**
 * База данных — SQLite через sql.js
 * Оптимизации:
 *  - _save() через debounce 50мс — один сброс на серию операций
 *  - _saveNow() для критических операций
 *  - reason, parentEmail — в _migrate()
 *  - getTodaySummary использует Intl.DateTimeFormat (правильный TZ)
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_FILE    = path.join(__dirname, '../data/db.sqlite');
const BACKUP_DIR = path.join(__dirname, '../data/backups');

let sql = null;
let db  = null;
let _saveTimer = null;

// ── Инициализация ─────────────────────────────────────────────────────────────
async function init() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const SQL = await require('sql.js')();
  sql = SQL;
  db  = fs.existsSync(DB_FILE)
    ? new SQL.Database(fs.readFileSync(DB_FILE))
    : new SQL.Database();
  _migrate();
  _saveNow();
  console.log('✅ SQLite:', DB_FILE);
}

// ── Сохранение (debounced) ────────────────────────────────────────────────────
function _save() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => { _saveTimer = null; _saveNow(); }, 50);
}
function _saveNow() {
  if (db) fs.writeFileSync(DB_FILE, db.export());
}

// ── Бэкап ─────────────────────────────────────────────────────────────────────
function backup() {
  const name = `db_${new Date().toISOString().slice(0, 10)}.sqlite`;
  const dest = path.join(BACKUP_DIR, name);
  if (fs.existsSync(dest)) return { skipped: true, file: dest };
  fs.writeFileSync(dest, db.export());
  // Удаляем бэкапы старше 30 дней
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    const fp = path.join(BACKUP_DIR, f);
    try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch {}
  }
  return { skipped: false, file: dest };
}

// ── Миграции ──────────────────────────────────────────────────────────────────
function _migrate() {
  db.run(`CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    lessonStartTime TEXT DEFAULT '', lateMinutes INTEGER DEFAULT 10, createdAt TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS students (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    parentPhone TEXT DEFAULT '', parentName TEXT DEFAULT 'Родитель',
    parentEmail TEXT DEFAULT '', telegramChatId TEXT DEFAULT '',
    groupId TEXT DEFAULT '', consentDate TEXT DEFAULT '',
    isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id TEXT PRIMARY KEY, studentId TEXT NOT NULL, studentName TEXT NOT NULL,
    groupId TEXT DEFAULT '', isLate INTEGER DEFAULT 0, minutesLate INTEGER DEFAULT 0,
    reason TEXT DEFAULT '', time TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, entity TEXT NOT NULL,
    entityId TEXT DEFAULT '', details TEXT DEFAULT '', ip TEXT DEFAULT '', time TEXT NOT NULL
  )`);

  // Добавляем колонки если не существуют (upgrade старых БД)
  _col('students',   'parentEmail',    'TEXT DEFAULT ""');
  _col('students',   'telegramStopAt', 'TEXT DEFAULT ""');
  _col('attendance', 'reason',         'TEXT DEFAULT ""');
}

function _col(tbl, col, def) {
  try { db.run(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${def}`); } catch {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _all(q, p = []) {
  const res = db.exec(q, p);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(row => { const o = {}; columns.forEach((c, i) => o[c] = row[i]); return o; });
}
function _get(q, p = [])   { return _all(q, p)[0] || null; }
function _run(q, p = [])   { db.run(q, p); _save(); }
function _id()              { return uuidv4(); }

// ── Часовой пояс ──────────────────────────────────────────────────────────────
function _localDate(tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch { return new Date().toISOString().slice(0, 10); }
}
function _sameDay(isoTime, date, tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(isoTime)) === date;
  } catch { return isoTime.slice(0, 10) === date; }
}

// ═══════════════════════════════════════════════════
// АУДИТ
// ═══════════════════════════════════════════════════
function audit(action, entity, entityId = '', details = '', ip = '') {
  try { _run('INSERT INTO audit_log VALUES (?,?,?,?,?,?,?)',
    [_id(), action, entity, entityId, details, ip, new Date().toISOString()]); } catch {}
}
function getAuditLog(limit = 100) {
  return _all('SELECT * FROM audit_log ORDER BY time DESC LIMIT ?', [limit]);
}

// ═══════════════════════════════════════════════════
// ГРУППЫ
// ═══════════════════════════════════════════════════
function getGroups() { return _all('SELECT * FROM groups ORDER BY name'); }

function addGroup({ name, lessonStartTime = '', lateMinutes = 10 }) {
  const g = { id: _id(), name, lessonStartTime, lateMinutes: Number(lateMinutes), createdAt: new Date().toISOString() };
  _run('INSERT INTO groups VALUES (?,?,?,?,?)', [g.id, g.name, g.lessonStartTime, g.lateMinutes, g.createdAt]);
  return g;
}

function updateGroup(id, fields) {
  const allowed = ['name', 'lessonStartTime', 'lateMinutes'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return findGroup(id);
  _run(`UPDATE groups SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`,
    [...keys.map(k => fields[k]), id]);
  return findGroup(id);
}
function deleteGroup(id) { _run('DELETE FROM groups WHERE id=?', [id]); }
function findGroup(id)   { return _get('SELECT * FROM groups WHERE id=?', [id]); }

// ═══════════════════════════════════════════════════
// УЧЕНИКИ
// ═══════════════════════════════════════════════════
function getStudents(groupId = null, includeArchived = false) {
  let q = 'SELECT * FROM students WHERE 1=1';
  const p = [];
  if (!includeArchived) { q += ' AND isActive=1'; }
  if (groupId) { q += ' AND groupId=?'; p.push(groupId); }
  q += ' ORDER BY name';
  return _all(q, p);
}

function addStudent({ name, parentPhone = '', parentName = 'Родитель', parentEmail = '',
                      telegramChatId = '', groupId = '', consentDate = '' }) {
  const s = {
    id: _id(), name,
    parentPhone:    parentPhone.replace(/\D/g, ''),
    parentName,
    parentEmail:    (parentEmail || '').trim().toLowerCase(),
    telegramChatId: telegramChatId.trim(),
    groupId, consentDate, isActive: 1,
    createdAt: new Date().toISOString(),
  };
  _run('INSERT INTO students (id,name,parentPhone,parentName,parentEmail,telegramChatId,groupId,consentDate,isActive,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [s.id, s.name, s.parentPhone, s.parentName, s.parentEmail, s.telegramChatId, s.groupId, s.consentDate, s.isActive, s.createdAt]);
  return s;
}

function updateStudent(id, fields) {
  const allowed = ['name','parentPhone','parentName','parentEmail','telegramChatId','groupId','consentDate','isActive','telegramStopAt'];
  const clean = {};
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      if (k === 'parentPhone') clean[k] = String(fields[k]).replace(/\D/g, '');
      else if (k === 'parentEmail') clean[k] = String(fields[k] || '').trim().toLowerCase();
      else clean[k] = fields[k];
    }
  }
  const keys = Object.keys(clean);
  if (!keys.length) return findStudent(id);
  _run(`UPDATE students SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`,
    [...keys.map(k => clean[k]), id]);
  return findStudent(id);
}

function deleteStudent(id)  { _run('DELETE FROM students WHERE id=?', [id]); }
function archiveStudent(id) { _run('UPDATE students SET isActive=0 WHERE id=?', [id]); return findStudent(id); }
function findStudent(id)    { return _get('SELECT * FROM students WHERE id=?', [id]); }

// Токен для личного кабинета — первые 12 hex-символов ID
function getOrCreateParentToken(studentId) {
  const s = findStudent(studentId);
  return s ? s.id.replace(/-/g, '').slice(0, 12) : null;
}

// Найти ученика по токену
function findStudentByToken(token) {
  const students = getStudents(null, true);
  return students.find(s => s.id.replace(/-/g, '').slice(0, 12) === token) || null;
}

// GDPR — полное удаление
function gdprDeleteStudent(id) {
  const s = findStudent(id);
  _run('DELETE FROM attendance WHERE studentId=?', [id]);
  _run('DELETE FROM students WHERE id=?', [id]);
  _saveNow();
  return s;
}

// ═══════════════════════════════════════════════════
// ПОСЕЩАЕМОСТЬ
// ═══════════════════════════════════════════════════
function addAttendance(studentId) {
  const student = findStudent(studentId);
  if (!student) return null;
  let isLate = 0, minutesLate = 0;
  if (student.groupId) {
    const group = findGroup(student.groupId);
    if (group && group.lessonStartTime) {
      const raw = _calcLate(group.lessonStartTime);
      if (raw > (group.lateMinutes || 10)) { isLate = 1; minutesLate = raw; }
    }
  }
  const rec = { id: _id(), studentId, studentName: student.name,
    groupId: student.groupId || '', isLate, minutesLate, reason: '', time: new Date().toISOString() };
  _run('INSERT INTO attendance (id,studentId,studentName,groupId,isLate,minutesLate,reason,time) VALUES (?,?,?,?,?,?,?,?)',
    [rec.id, rec.studentId, rec.studentName, rec.groupId, rec.isLate, rec.minutesLate, rec.reason, rec.time]);
  return rec;
}

function addManualAttendance(studentId, reason) {
  const student = findStudent(studentId);
  if (!student) return null;
  const rec = { id: _id(), studentId, studentName: student.name,
    groupId: student.groupId || '', isLate: 0, minutesLate: 0, reason: reason || '', time: new Date().toISOString() };
  _run('INSERT INTO attendance (id,studentId,studentName,groupId,isLate,minutesLate,reason,time) VALUES (?,?,?,?,?,?,?,?)',
    [rec.id, rec.studentId, rec.studentName, rec.groupId, 0, 0, rec.reason, rec.time]);
  return rec;
}

function getLastAttendance(studentId) {
  return _get('SELECT * FROM attendance WHERE studentId=? ORDER BY time DESC LIMIT 1', [studentId]);
}

function getAttendance(limit = 200, groupId = null) {
  if (groupId) return _all(
    'SELECT a.*, g.name AS groupName FROM attendance a LEFT JOIN groups g ON a.groupId=g.id WHERE a.groupId=? ORDER BY a.time DESC LIMIT ?',
    [groupId, limit]);
  return _all(
    'SELECT a.*, g.name AS groupName FROM attendance a LEFT JOIN groups g ON a.groupId=g.id ORDER BY a.time DESC LIMIT ?',
    [limit]);
}

function getStudentStats(studentId, months = 6) {
  const rows = _all('SELECT * FROM attendance WHERE studentId=? ORDER BY time DESC', [studentId]);
  const map = {};
  for (const r of rows) {
    const month = r.time.slice(0, 7);
    if (!map[month]) map[month] = { month, total: 0, late: 0, onTime: 0 };
    map[month].total++;
    r.isLate ? map[month].late++ : map[month].onTime++;
  }
  return Object.values(map).sort((a, b) => b.month.localeCompare(a.month)).slice(0, months);
}

function getAllAttendance(groupId = null) {
  let q = `SELECT a.*, s.parentName, s.parentEmail, g.name AS groupName
           FROM attendance a
           LEFT JOIN students s ON a.studentId=s.id
           LEFT JOIN groups g ON a.groupId=g.id`;
  const p = [];
  if (groupId) { q += ' WHERE a.groupId=?'; p.push(groupId); }
  q += ' ORDER BY a.time DESC';
  return _all(q, p);
}

function getStudentAttendance(studentId, limit = 50) {
  return _all(
    'SELECT a.*, g.name AS groupName FROM attendance a LEFT JOIN groups g ON a.groupId=g.id WHERE a.studentId=? ORDER BY a.time DESC LIMIT ?',
    [studentId, limit]);
}

// ── Дашборд ───────────────────────────────────────────────────────────────────
function getTodaySummary(tz) {
  const timezone = tz || 'UTC';
  const today    = _localDate(timezone);
  const cutoff   = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const recs     = _all('SELECT * FROM attendance WHERE time >= ?', [cutoff]);
  const todayRecs = recs.filter(r => _sameDay(r.time, today, timezone));
  const unique    = new Set(todayRecs.map(r => r.studentId));
  return { total: getStudents().length, present: unique.size, late: todayRecs.filter(r => r.isLate).length, today };
}

function getAttendanceByDays(tz, days = 7) {
  const timezone = tz || 'UTC';
  const result   = [];
  for (let i = days - 1; i >= 0; i--) {
    const date  = _localDate(timezone) > '' ? new Intl.DateTimeFormat('en-CA', { timeZone: timezone })
      .format(new Date(Date.now() - i * 24 * 3600 * 1000)) : '';
    const recs  = _all('SELECT * FROM attendance WHERE time >= ? AND time < ?',
      [new Date(Date.now() - (i + 1) * 24 * 3600 * 1000).toISOString(),
       new Date(Date.now() - i * 24 * 3600 * 1000).toISOString()]);
    const day   = recs.filter(r => _sameDay(r.time, date, timezone));
    result.push({ date, present: new Set(day.map(r => r.studentId)).size, late: day.filter(r => r.isLate).length });
  }
  return result;
}

// ── Автоочистка ───────────────────────────────────────────────────────────────
function autoCleanup(retentionYears) {
  if (!retentionYears || retentionYears <= 0) return 0;
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - retentionYears);
  const n = (_all('SELECT COUNT(*) as n FROM attendance WHERE time < ?', [cutoff.toISOString()])[0]?.n) || 0;
  if (n > 0) { _run('DELETE FROM attendance WHERE time < ?', [cutoff.toISOString()]); _saveNow(); }
  return n;
}

function _calcLate(t) {
  const [hh, mm] = t.split(':').map(Number);
  if (isNaN(hh)) return 0;
  const s = new Date(); s.setHours(hh, mm, 0, 0);
  return Math.max(0, Math.floor((Date.now() - s.getTime()) / 60000));
}

module.exports = {
  init, backup,
  getGroups, addGroup, updateGroup, deleteGroup, findGroup,
  getStudents, addStudent, updateStudent, deleteStudent, archiveStudent,
  findStudent, gdprDeleteStudent, getOrCreateParentToken, findStudentByToken,
  addAttendance, addManualAttendance, getLastAttendance,
  getAttendance, getStudentStats, getAllAttendance, getStudentAttendance,
  getTodaySummary, getAttendanceByDays,
  audit, getAuditLog,
  autoCleanup,
};
