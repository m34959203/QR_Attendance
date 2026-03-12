'use strict';
const express    = require('express');
const rateLimit  = require('express-rate-limit');
const helmet     = require('helmet');
const QRCode     = require('qrcode');
const fs         = require('fs');
const path       = require('path');
const db         = require('./db');
const wa         = require('./whatsapp');
const tg         = require('./telegram');
const em         = require('./email');
const config     = require('./config');
const { autoClean } = require('./cleanup');
const { validateStudent, validateGroup, validatePhone, validateMessage } = require('./validate');

const app = express();

// ── Безопасность ──────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],   // нужен для inline JS в index.html
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", 'data:'],
      connectSrc:  ["'self'"],
      fontSrc:     ["'self'"],
      objectSrc:   ["'none'"],
      frameAncestors: ["'none'"],
      formAction:  ["'self'"],
      baseUri:     ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── Логирование ошибок ────────────────────────────────────────────────────────
const LOG_FILE = path.join(__dirname, '../data/error.log');

function logError(msg, req = null) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    msg,
    url:  req ? req.originalUrl : undefined,
    ip:   req ? (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '') : undefined,
  }) + '\n';
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  console.error('❌', msg);
}

// ── Rate Limiting ─────────────────────────────────────────────────────────────
const scanLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: 'Слишком много запросов. Подождите минуту.',
  standardHeaders: true, legacyHeaders: false,
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 100,   // 100 запросов / 15 мин
  message: 'Слишком много запросов к панели управления.',
  standardHeaders: true, legacyHeaders: false,
});

const authFailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,     // 5 неверных паролей → блок на 15 мин
  skipSuccessfulRequests: true,
  message: 'Слишком много неверных попыток входа. Подождите 15 минут.',
  standardHeaders: true, legacyHeaders: false,
});

const apiWriteLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,         // 30 мутаций / мин
  message: 'Слишком много запросов на запись. Подождите.',
  standardHeaders: true, legacyHeaders: false,
});

// ── Telegram Webhook (публичный — до Basic Auth) ──────────────────────────────
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);
  if (req.body) await tg.handleWebhookUpdate(req.body).catch(e => logError(e.message));
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ts: new Date().toISOString() });
});

// ── Basic Auth ────────────────────────────────────────────────────────────────
const authGuard = [adminLimiter, authFailLimiter, (req, res, next) => {
  const auth = req.headers.authorization;
  if (auth) {
    const [, enc] = auth.split(' ');
    const [, pwd] = Buffer.from(enc || '', 'base64').toString().split(':');
    if (pwd === config.ADMIN_PASSWORD) {
      req.adminIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Панель учителя"');
  res.status(401).send('Требуется пароль');
}];

app.use('/admin', ...authGuard);
app.use('/api',   ...authGuard);
app.post('/api/*', apiWriteLimiter);
app.put('/api/*',  apiWriteLimiter);
app.delete('/api/*', apiWriteLimiter);
app.use(express.static('public'));

// ── Старт ─────────────────────────────────────────────────────────────────────
(async () => {
  await db.init();
  em.init();
  wa.init();
  await tg.init();
  autoClean();

  // Делаем бэкап при старте (не чаще раза в день)
  try { const r = db.backup(); if (!r.skipped) console.log('💾 Бэкап при старте:', r.file); }
  catch (e) { logError('backup at start: ' + e.message); }

  app.listen(config.PORT, () => {
    console.log(`\n🚀 http://localhost:${config.PORT}/admin`);
    console.log(`🏫 ${config.SCHOOL_NAME}\n`);
  });
})();

// ═══════════════════════════════════════════════════
// QR СКАНИРОВАНИЕ
// ═══════════════════════════════════════════════════
app.get('/scan/:studentId', scanLimiter, async (req, res) => {
  try {
    const student = db.findStudent(req.params.studentId);
    if (!student || !student.isActive) {
      return res.send(scanPage('Ошибка', `<div class="icon">❌</div><h2>QR-код не найден</h2><p>Обратитесь к учителю</p>`));
    }

    // Защита от двойного скана (10 мин)
    const last = db.getLastAttendance(student.id);
    if (last && (Date.now() - new Date(last.time).getTime()) < 10 * 60000) {
      return res.send(scanPage('Уже отмечен', `
        <div class="icon">✅</div><h2>${esc(student.name)}</h2>
        <p class="already">Уже отмечены сегодня</p>
        <p class="time">Приход: <strong>${fmt(last.time)}</strong></p>`));
    }

    const record = db.addAttendance(student.id);
    const time   = fmt(record.time);
    const date   = fmtDate(record.time);
    const school = config.SCHOOL_NAME;
    const lateNote  = record.isLate ? `\n⚠️ Опоздание: ${record.minutesLate} мин` : '';

    // WhatsApp
    if (student.parentPhone) {
      const waText = `[${school}]\n👋 Здравствуйте, ${student.parentName}!\n\n✅ ${student.name} пришёл(а) на урок.\n🕐 ${time}\n📅 ${date}${lateNote}`;
      wa.send(student.parentPhone, waText, student.name);
    }

    // Telegram (только если не отписан)
    if (student.telegramChatId && !student.telegramStopAt) {
      const late = record.isLate ? `\n⚠️ Опоздание: <b>${record.minutesLate} мин</b>` : '';
      const tgText = `[<b>${esc(school)}</b>]\n👋 ${esc(student.parentName)},\n\n${record.isLate?'⚠️':'✅'} <b>${esc(student.name)}</b> пришёл(а).\n🕐 <b>${time}</b>\n📅 ${date}${late}`;
      tg.sendMessage(student.telegramChatId, tgText).catch(e => logError('TG: ' + e.message));
    }

    // Email
    if (student.parentEmail) {
      em.sendArrival({
        to: student.parentEmail, parentName: student.parentName,
        studentName: student.name, time, date, school,
        isLate: record.isLate, minutesLate: record.minutesLate,
      }).catch(e => logError('Email: ' + e.message));
    }

    db.audit('scan', 'attendance', record.id,
      `${student.name} — ${time}${record.isLate ? ' (опоздание)' : ''}`,
      req.headers['x-forwarded-for'] || req.socket.remoteAddress || '');

    res.send(scanPage('Добро пожаловать!', `
      <div class="icon">${record.isLate ? '⏰' : '🎓'}</div>
      <h2>${esc(student.name)}</h2>
      <p class="school">${esc(school)}</p>
      <p class="time">Приход: <strong>${time}</strong></p>
      ${record.isLate ? `<p class="late">⚠️ Опоздание: ${record.minutesLate} мин</p>` : ''}
      <p class="wa-ok">📨 Уведомление отправлено</p>`));
  } catch (e) {
    logError(e.message, req);
    res.status(500).send(scanPage('Ошибка', `<div class="icon">⚠️</div><p>Временная ошибка. Попробуйте ещё раз.</p>`));
  }
});

// ═══════════════════════════════════════════════════
// ЛИЧНЫЙ КАБИНЕТ РОДИТЕЛЯ (публичный)
// ═══════════════════════════════════════════════════
app.get('/parent/:token', (req, res) => {
  const student = db.findStudentByToken(req.params.token);
  if (!student) return res.status(404).send(scanPage('Не найдено', `<div class="icon">❌</div><p>Страница не найдена</p>`));
  const records = db.getStudentAttendance(student.id, 30);
  const stats   = db.getStudentStats(student.id, 3);
  const total   = stats.reduce((a, s) => a + s.total, 0);
  const late    = stats.reduce((a, s) => a + s.late,  0);
  const school  = config.SCHOOL_NAME;

  const rows = records.map(r => {
    const d  = new Date(r.time);
    const dt = d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: config.TIMEZONE });
    const tm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: config.TIMEZONE });
    const st = r.reason === 'sick' ? '🤒 Болен' : r.reason === 'valid' ? '📝 Уваж.' : r.isLate ? `⚠️ +${r.minutesLate}мин` : '✅';
    return `<tr><td>${dt}</td><td>${tm}</td><td>${st}</td></tr>`;
  }).join('');

  res.send(`<!DOCTYPE html><html lang="ru"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Посещаемость — ${esc(student.name)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#f0f2f5;padding:16px;color:#1a1a2e}
.card{background:#fff;border-radius:16px;padding:20px;margin-bottom:16px;box-shadow:0 2px 8px rgba(0,0,0,.06)}
h1{font-size:22px;margin-bottom:4px}
.sub{font-size:13px;color:#aaa;margin-bottom:16px}
.stats{display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap}
.stat{flex:1;min-width:80px;background:#f7f9fc;border-radius:12px;padding:14px;text-align:center}
.stat .n{font-size:28px;font-weight:800;color:#2E5FA3}
.stat .l{font-size:10px;color:#aaa;text-transform:uppercase;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#f7f9fc;padding:10px;text-align:left;font-size:11px;color:#888;text-transform:uppercase}
td{padding:10px;border-bottom:1px solid #f0f2f5}
header{background:linear-gradient(135deg,#2E5FA3,#4472C4);padding:16px 20px;border-radius:16px;margin-bottom:16px;color:#fff}
header h2{font-size:16px;margin-bottom:2px}header p{font-size:12px;opacity:.8}
footer{text-align:center;font-size:12px;color:#aaa;margin-top:16px}
footer a{color:#2E5FA3;text-decoration:none}
</style></head><body>
<header><h2>🎓 ${esc(school)}</h2><p>Личный кабинет родителя</p></header>
<div class="card">
  <h1>${esc(student.name)}</h1>
  <div class="sub">История посещаемости за последние 30 занятий</div>
  <div class="stats">
    <div class="stat"><div class="n">${total}</div><div class="l">Всего</div></div>
    <div class="stat"><div class="n" style="color:#27ae60">${total - late}</div><div class="l">Вовремя</div></div>
    <div class="stat"><div class="n" style="color:#e53935">${late}</div><div class="l">Опозданий</div></div>
    <div class="stat"><div class="n" style="color:#f39c12">${total ? Math.round((1 - late/total)*100) : 0}%</div><div class="l">Точность</div></div>
  </div>
  <table>
    <thead><tr><th>Дата</th><th>Время</th><th>Статус</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3" style="text-align:center;color:#aaa;padding:24px">Посещений пока нет</td></tr>'}</tbody>
  </table>
</div>
<footer><a href="/privacy">Политика конфиденциальности</a> · <a href="/help">Помощь</a></footer>
</body></html>`);
});

// ═══════════════════════════════════════════════════
// API: ДАШБОРД
// ═══════════════════════════════════════════════════
app.get('/api/dashboard', (req, res) => {
  res.json({
    summary:  db.getTodaySummary(config.TIMEZONE),
    chart:    db.getAttendanceByDays(config.TIMEZONE, 7),
    wa:       wa.getStatus(),
    email:    em.getStatus(),
    students: db.getStudents().length,
    groups:   db.getGroups().length,
  });
});

// ═══════════════════════════════════════════════════
// API: ГРУППЫ
// ═══════════════════════════════════════════════════
app.get('/api/groups', (req, res) => res.json(db.getGroups()));

app.post('/api/groups', (req, res) => {
  const errs = validateGroup(req.body);
  if (errs) return res.status(400).json({ error: errs[0], errors: errs });
  const { name, lessonStartTime, lateMinutes } = req.body;
  const g = db.addGroup({ name: name.trim(), lessonStartTime: lessonStartTime || '', lateMinutes: Number(lateMinutes) || 10 });
  db.audit('create', 'group', g.id, g.name, req.adminIp);
  res.json(g);
});

app.put('/api/groups/:id', (req, res) => {
  const g = db.updateGroup(req.params.id, req.body);
  db.audit('update', 'group', req.params.id, JSON.stringify(req.body), req.adminIp);
  res.json(g);
});

app.delete('/api/groups/:id', (req, res) => {
  db.audit('delete', 'group', req.params.id, '', req.adminIp);
  db.deleteGroup(req.params.id);
  res.json({ ok: true });
});

app.post('/api/groups/:id/duplicate', (req, res) => {
  const src = db.findGroup(req.params.id);
  if (!src) return res.status(404).json({ error: 'Не найдена' });
  const g = db.addGroup({ name: src.name + ' (копия)', lessonStartTime: src.lessonStartTime, lateMinutes: src.lateMinutes });
  db.audit('duplicate', 'group', g.id, src.name, req.adminIp);
  res.json(g);
});

app.post('/api/groups/:id/broadcast', async (req, res) => {
  const msgErr = validateMessage(req.body.message);
  if (msgErr) return res.status(400).json({ error: msgErr });
  const { message } = req.body;
  const students = db.getStudents(req.params.id);
  let sent = 0, failed = 0;
  for (const s of students) {
    const text = `[${config.SCHOOL_NAME}]\n👋 ${s.parentName},\n\n${message}`;
    if (s.parentPhone) { wa.send(s.parentPhone, text, s.name); sent++; }
    if (s.telegramChatId && !s.telegramStopAt) {
      try { await tg.sendMessage(s.telegramChatId, `[<b>${esc(config.SCHOOL_NAME)}</b>]\n👋 ${esc(s.parentName)},\n\n${esc(message)}`); sent++; }
      catch { failed++; }
    }
    if (s.parentEmail) {
      await em.send(s.parentEmail, `[${config.SCHOOL_NAME}] Сообщение от учителя`,
        `<p>👋 ${esc(s.parentName)},</p><p>${esc(message)}</p>`).catch(() => failed++);
    }
  }
  db.audit('broadcast', 'group', req.params.id, `sent:${sent}`, req.adminIp);
  res.json({ ok: true, sent, failed });
});

// ═══════════════════════════════════════════════════
// API: УЧЕНИКИ
// ═══════════════════════════════════════════════════
app.get('/api/students', (req, res) => {
  const { groupId, search, archived } = req.query;
  let students = db.getStudents(groupId || null, archived === '1');
  if (search) {
    const q = search.toLowerCase();
    students = students.filter(s =>
      s.name.toLowerCase().includes(q) ||
      (s.parentName || '').toLowerCase().includes(q) ||
      (s.parentPhone || '').includes(q));
  }
  res.json(students);
});

app.post('/api/students', async (req, res) => {
  const errs = validateStudent(req.body);
  if (errs) return res.status(400).json({ error: errs[0], errors: errs });
  const { name, parentPhone, parentName, parentEmail, telegramChatId, groupId, consentDate } = req.body;
  const s   = db.addStudent({ name: name.trim(), parentPhone, parentName, parentEmail, telegramChatId, groupId, consentDate });
  const url = `${config.BASE_URL}/scan/${s.id}`;
  const parentUrl = `${config.BASE_URL}/parent/${db.getOrCreateParentToken(s.id)}`;
  db.audit('create', 'student', s.id, s.name, req.adminIp);
  res.json({ ...s, qrImage: await QRCode.toDataURL(url, { width: 300, margin: 2 }), qrUrl: url, parentUrl });
});

app.put('/api/students/:id', (req, res) => {
  if (req.body.name !== undefined || req.body.parentPhone !== undefined || req.body.parentEmail !== undefined) {
    const errs = validateStudent({ name: req.body.name || 'x', ...req.body });
    if (errs) return res.status(400).json({ error: errs[0], errors: errs });
  }
  const s = db.updateStudent(req.params.id, req.body);
  if (!s) return res.status(404).json({ error: 'Не найден' });
  db.audit('update', 'student', req.params.id, JSON.stringify(Object.keys(req.body)), req.adminIp);
  res.json(s);
});

app.delete('/api/students/:id', (req, res) => {
  db.audit('delete', 'student', req.params.id, '', req.adminIp);
  db.deleteStudent(req.params.id);
  res.json({ ok: true });
});

app.post('/api/students/:id/archive', (req, res) => {
  db.audit('archive', 'student', req.params.id, '', req.adminIp);
  res.json(db.archiveStudent(req.params.id));
});

app.delete('/api/students/:id/gdpr', (req, res) => {
  const s = db.gdprDeleteStudent(req.params.id);
  db.audit('gdpr_delete', 'student', req.params.id, s ? s.name : '', req.adminIp);
  res.json({ ok: true, deleted: s?.name });
});

app.get('/api/students/:id/qr', async (req, res) => {
  const s = db.findStudent(req.params.id);
  if (!s) return res.status(404).json({ error: 'Не найден' });
  const url = `${config.BASE_URL}/scan/${s.id}`;
  res.json({ qrImage: await QRCode.toDataURL(url, { width: 300, margin: 2 }), url, student: s });
});

app.get('/api/students/:id/stats', (req, res) => {
  res.json(db.getStudentStats(req.params.id, 6));
});

app.post('/api/students/:id/manual', (req, res) => {
  const { reason } = req.body;
  const s = db.findStudent(req.params.id);
  if (!s) return res.status(404).json({ error: 'Не найден' });
  const rec = db.addManualAttendance(req.params.id, reason);
  db.audit('manual', 'attendance', rec.id, `${s.name} — ${reason}`, req.adminIp);
  res.json(rec);
});

app.post('/api/students/import', (req, res) => {
  const { students, groupId } = req.body;
  if (!Array.isArray(students)) return res.status(400).json({ error: 'Нужен массив students' });
  const results = [];
  for (const row of students) {
    if (!row.name?.trim()) continue;
    try {
      const s = db.addStudent({ ...row, name: row.name.trim(), groupId: groupId || row.groupId || '' });
      results.push({ ok: true, id: s.id, name: s.name });
    } catch (e) {
      results.push({ ok: false, name: row.name, error: e.message });
    }
  }
  db.audit('import', 'students', '', `${results.filter(r => r.ok).length}/${students.length}`, req.adminIp);
  res.json(results);
});

// ═══════════════════════════════════════════════════
// API: ПОСЕЩАЕМОСТЬ
// ═══════════════════════════════════════════════════
app.get('/api/attendance', (req, res) => {
  res.json(db.getAttendance(200, req.query.groupId || null));
});

app.get('/api/attendance/export', async (req, res) => {
  const ExcelJS = require('exceljs');
  let rows = db.getAllAttendance(req.query.groupId || null);
  if (req.query.from) rows = rows.filter(r => r.time >= req.query.from);
  if (req.query.to)   rows = rows.filter(r => r.time <= req.query.to + 'T23:59:59Z');

  const wb = new ExcelJS.Workbook();
  wb.creator = config.SCHOOL_NAME;
  const ws = wb.addWorksheet('Посещаемость');
  ws.columns = [
    { header: 'Ученик',        key: 'studentName', width: 25 },
    { header: 'Группа',        key: 'groupName',   width: 20 },
    { header: 'Дата',          key: 'date',        width: 14 },
    { header: 'Время',         key: 'time',        width: 10 },
    { header: 'Статус',        key: 'status',      width: 20 },
    { header: 'Опоздание мин', key: 'minutesLate', width: 14 },
    { header: 'Родитель',      key: 'parentName',  width: 22 },
    { header: 'Email',         key: 'parentEmail', width: 28 },
  ];
  ws.getRow(1).eachCell(c => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E5FA3' } };
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  });
  for (const r of rows) {
    const d = new Date(r.time);
    ws.addRow({
      studentName: r.studentName, groupName: r.groupName || '—',
      date: d.toLocaleDateString('ru-RU', { timeZone: config.TIMEZONE }),
      time: d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: config.TIMEZONE }),
      status: r.reason === 'sick' ? '🤒 Болен' : r.reason === 'valid' ? '📝 Уваж.' : r.isLate ? '⚠️ Опоздал(а)' : '✅ Вовремя',
      minutesLate: r.isLate ? r.minutesLate : 0,
      parentName:  r.parentName  || '—',
      parentEmail: r.parentEmail || '—',
    });
  }
  ws.eachRow((row, i) => {
    if (i > 1 && i % 2 === 0) row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F4FA' } }; });
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="attendance_${new Date().toISOString().slice(0,10)}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ═══════════════════════════════════════════════════
// API: ПЕЧАТЬ QR
// ═══════════════════════════════════════════════════
app.get('/api/print-all', async (req, res) => {
  const students = db.getStudents(req.query.groupId || null);
  const result = [];
  for (const s of students) {
    const url = `${config.BASE_URL}/scan/${s.id}`;
    result.push({ ...s, qrImage: await QRCode.toDataURL(url, { width: 250, margin: 2 }), url });
  }
  res.json(result);
});

// ═══════════════════════════════════════════════════
// API: WHATSAPP / TELEGRAM / EMAIL
// ═══════════════════════════════════════════════════
app.get('/api/whatsapp/status', (req, res) => res.json(wa.getStatus()));
app.get('/api/whatsapp/log',    (req, res) => res.json(wa.getLog(100)));

app.post('/api/whatsapp/test', async (req, res) => {
  const phoneErr = validatePhone(req.body.phone);
  if (phoneErr) return res.status(400).json({ error: phoneErr });
  const phone = String(req.body.phone).replace(/\D/g, '');
  try {
    await wa.sendDirect(phone, `[${config.SCHOOL_NAME}] ✅ Тестовое сообщение от QR-системы посещаемости. Всё работает!`);
    db.audit('test_wa', 'whatsapp', '', phone, req.adminIp);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/telegram/status', async (req, res) => res.json(await tg.getStatus()));

app.post('/api/telegram/test', async (req, res) => {
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'Укажите chat_id' });
  try {
    await tg.sendMessage(chatId, `[<b>${esc(config.SCHOOL_NAME)}</b>] ✅ Тестовое сообщение от QR-системы посещаемости. Всё работает!`);
    db.audit('test_tg', 'telegram', '', String(chatId), req.adminIp);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/email/status', (req, res) => res.json(em.getStatus()));

app.post('/api/email/test', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Укажите email' });
  try {
    await em.sendTest(email, config.SCHOOL_NAME);
    db.audit('test_email', 'email', '', email, req.adminIp);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════
// API: АУДИТ / ЛОГИ
// ═══════════════════════════════════════════════════
app.get('/api/audit', (req, res) => res.json(db.getAuditLog(200)));

app.get('/api/error-log', (req, res) => {
  try {
    if (!fs.existsSync(LOG_FILE)) return res.json([]);
    const lines = fs.readFileSync(LOG_FILE, 'utf-8').trim().split('\n').filter(Boolean).reverse().slice(0, 50);
    res.json(lines.map(l => { try { return JSON.parse(l); } catch { return { msg: l }; } }));
  } catch { res.json([]); }
});

// ═══════════════════════════════════════════════════
// СТРАНИЦЫ
// ═══════════════════════════════════════════════════
app.get('/admin',   ...authGuard, (req, res) => res.sendFile('index.html',   { root: 'public' }));
app.get('/privacy', (req, res) => res.sendFile('privacy.html', { root: 'public' }));
app.get('/help',    (req, res) => res.sendFile('help.html',    { root: 'public' }));
app.get('/',        (req, res) => res.redirect('/admin'));

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).send(scanPage('404', `<div class="icon">🔍</div><h2>Страница не найдена</h2>`)));

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  logError(err.message, req);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(iso) {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: config.TIMEZONE });
}
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: config.TIMEZONE });
}
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function scanPage(title, content) {
  return `<!DOCTYPE html><html lang="ru"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#667eea">
<title>${title} — ${esc(config.SCHOOL_NAME)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);
     min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:24px;padding:48px 40px;text-align:center;
      box-shadow:0 20px 60px rgba(0,0,0,.2);max-width:380px;width:100%}
.icon{font-size:72px;margin-bottom:16px}
h2{font-size:26px;color:#1a1a2e;margin-bottom:8px}
.school{font-size:13px;color:#aaa;margin-bottom:12px}
p{color:#666;margin:8px 0;font-size:16px}
.time{font-size:20px;color:#1a1a2e;margin:16px 0}.time strong{color:#667eea}
.wa-ok{color:#27ae60;font-weight:500;margin-top:16px}
.already{color:#e67e22;font-weight:500}
.late{color:#e53935;font-weight:600;font-size:18px;margin-top:8px}
footer{margin-top:20px;font-size:11px;color:rgba(255,255,255,.5)}
footer a{color:rgba(255,255,255,.7);text-decoration:none}
</style></head><body>
<div class="card">${content}</div>
<footer><a href="/privacy">Политика конфиденциальности</a> · <a href="/help">Помощь</a></footer>
</body></html>`;
}
