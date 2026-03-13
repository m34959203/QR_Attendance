'use strict';
const express    = require('express');
const rateLimit  = require('express-rate-limit');
const helmet     = require('helmet');
const QRCode     = require('qrcode');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const db         = require('./db');
const wa         = require('./whatsapp');
const tg         = require('./telegram');
const em         = require('./email');
const config     = require('./config');
const { autoClean } = require('./cleanup');
const reminders = require('./reminders');
const { validateStudent, validateGroup, validatePhone, validateMessage } = require('./validate');

const app = express();
if (config.TRUST_PROXY) app.set('trust proxy', Number(config.TRUST_PROXY) || 1);

// ── Безопасность ──────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],   // нужен для inline <script> в index.html
      scriptSrcAttr: ["'unsafe-inline'"],            // нужен для onclick/onchange атрибутов
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", 'data:'],
      connectSrc:  ["'self'"],
      fontSrc:     ["'self'"],
      objectSrc:   ["'none'"],
      frameAncestors: ["'none'"],
      formAction:  ["'self'"],
      baseUri:     ["'self'"],
      upgradeInsecureRequests: null,                 // не форсировать HTTPS (локальный dev)
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// HTTPS enforce: редирект на HTTPS если BASE_URL начинается с https
if (config.BASE_URL.startsWith('https://')) {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] === 'http') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

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

const authFailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,    // 10 неверных паролей → блок на 15 мин
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401,  // считать только 401
  message: { error: 'Слишком много неверных попыток входа. Подождите 15 минут.' },
  standardHeaders: true, legacyHeaders: false,
});

const apiWriteLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,         // 60 мутаций / мин
  message: { error: 'Слишком много запросов на запись. Подождите.' },
  standardHeaders: true, legacyHeaders: false,
});

// ── Telegram Webhook (публичный — до Basic Auth) ──────────────────────────────
app.post('/telegram-webhook', async (req, res) => {
  if (!tg.verifyWebhookSecret(req.headers['x-telegram-bot-api-secret-token'])) {
    return res.sendStatus(403);
  }
  res.sendStatus(200);
  if (req.body) await tg.handleWebhookUpdate(req.body).catch(e => logError(e.message));
});

// ── Favicon (пустой, чтобы не было 404) ──────────────────────────────────────
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const dbReady = db.isReady();
  res.status(dbReady ? 200 : 503).json({
    status: dbReady ? 'ok' : 'db_not_ready',
    db: dbReady,
    uptime: Math.floor(process.uptime()),
    ts: new Date().toISOString(),
  });
});

// ── Basic Auth ────────────────────────────────────────────────────────────────
const authGuard = [authFailLimiter, (req, res, next) => {
  const auth = req.headers.authorization;
  if (auth) {
    const [, enc] = auth.split(' ');
    const [, pwd] = Buffer.from(enc || '', 'base64').toString().split(':');
    // Timing-safe сравнение: SHA-256 гарантирует одинаковую длину буферов
    const a = crypto.createHash('sha256').update(pwd || '').digest();
    const b = crypto.createHash('sha256').update(config.ADMIN_PASSWORD).digest();
    if (crypto.timingSafeEqual(a, b)) {
      req.adminIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Admin"');
  res.status(401).send('Требуется пароль');
}];

app.use('/admin', ...authGuard);
app.use('/api',   ...authGuard);

// CSRF защита: Origin обязателен для мутирующих запросов
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const origin = req.headers.origin || req.headers.referer || '';
    if (!origin) {
      return res.status(403).json({ error: 'Запрос отклонён (CSRF: отсутствует Origin)' });
    }
    const allowed = config.BASE_URL;
    if (!origin.startsWith(allowed) && !origin.startsWith('http://localhost') && !origin.startsWith('http://127.0.0.1')) {
      return res.status(403).json({ error: 'Запрос отклонён (CSRF)' });
    }
  }
  next();
});

app.use('/api', (req, res, next) => {
  if (!db.isReady()) return res.status(503).json({ error: 'База данных ещё не готова. Попробуйте через несколько секунд.' });
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) return apiWriteLimiter(req, res, next);
  next();
});
app.use(express.static('public'));

// ── Старт ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await db.init();
  } catch (e) {
    console.error('💀 Не удалось инициализировать БД:', e.message);
    process.exit(1);
  }

  // Предупреждение при слабом пароле
  if (config.ADMIN_PASSWORD === 'admin123') {
    console.warn('⚠️  ВНИМАНИЕ: Используется пароль по умолчанию (admin123)!');
    console.warn('   Установите ADMIN_PASSWORD в .env для безопасности.');
  }

  em.init();
  try { await wa.init(); } catch (e) { logError('wa.init: ' + e.message); }
  try { await tg.init(); } catch (e) { logError('tg.init: ' + e.message); }
  autoClean();
  reminders.start();

  // Делаем бэкап при старте (не чаще раза в день)
  try { const r = db.backup(); if (!r.skipped) console.log('💾 Бэкап при старте:', r.file); }
  catch (e) { logError('backup at start: ' + e.message); }

  const server = app.listen(config.PORT, () => {
    console.log(`\n🚀 http://localhost:${config.PORT}/admin`);
    console.log(`🎓 ${config.SCHOOL_NAME}\n`);
  });

  // Graceful shutdown
  const shutdown = (signal) => {
    console.log(`\n⏹ ${signal} получен, завершение...`);
    reminders.stop();
    server.close(() => {
      console.log('✅ Сервер остановлен');
      process.exit(0);
    });
    // Принудительный выход через 10 сек
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
})().catch(e => {
  console.error('💀 Критическая ошибка при запуске:', e);
  process.exit(1);
});

// ═══════════════════════════════════════════════════
// QR СКАНИРОВАНИЕ (QR группы + PIN ученика)
// ═══════════════════════════════════════════════════
app.get('/g/:groupId', scanLimiter, (req, res) => {
  const group = db.findGroup(req.params.groupId);
  if (!group) return res.send(scanPage('Ошибка', `<div class="icon">❌</div><h2>Группа не найдена</h2><p>QR-код недействителен</p>`));
  res.send(groupScanPage(group));
});

app.post('/g/:groupId', scanLimiter, async (req, res) => {
  try {
    const group = db.findGroup(req.params.groupId);
    if (!group) return res.status(404).json({ error: 'Группа не найдена' });

    const pin = String(req.body.pin || '').trim();
    if (!pin) return res.status(400).json({ error: 'Введите код ученика' });

    const student = db.findStudentByPin(group.id, pin);
    if (!student) return res.status(404).json({ error: 'Неверный код' });

    // Защита от двойного скана (10 мин)
    const last = db.getLastAttendance(student.id);
    if (last && (Date.now() - new Date(last.time).getTime()) < 10 * 60000) {
      return res.json({ already: true, name: student.name, time: fmt(last.time) });
    }

    const record = db.addAttendance(student.id);
    const time   = fmt(record.time);
    const date   = fmtDate(record.time);
    const school = config.SCHOOL_NAME;
    const lateNote = record.isLate ? `\n⚠️ Опоздание: ${record.minutesLate} мин` : '';

    // WhatsApp
    if (student.parentPhone) {
      wa.send(student.parentPhone,
        `[${school}]\n👋 Здравствуйте, ${student.parentName}!\n\n✅ ${student.name} пришёл(а) на занятие.\n🕐 ${time}\n📅 ${date}${lateNote}`,
        student.name);
    }

    // Telegram
    if (student.telegramChatId && !student.telegramStopAt) {
      const late = record.isLate ? `\n⚠️ Опоздание: <b>${record.minutesLate} мин</b>` : '';
      tg.sendMessage(student.telegramChatId,
        `[<b>${esc(school)}</b>]\n👋 ${esc(student.parentName)},\n\n${record.isLate?'⚠️':'✅'} <b>${esc(student.name)}</b> пришёл(а).\n🕐 <b>${time}</b>\n📅 ${date}${late}`
      ).catch(e => logError('TG: ' + e.message));
    }

    // Email
    if (student.parentEmail) {
      em.sendArrival({
        to: student.parentEmail, parentName: student.parentName,
        studentName: student.name, time, date, school,
        isLate: record.isLate, minutesLate: record.minutesLate,
      }).catch(e => logError('Email: ' + e.message));
    }

    db.audit('scan_pin', 'attendance', record.id,
      `${student.name} [PIN] — ${time}${record.isLate ? ' (опоздание)' : ''}`,
      req.headers['x-forwarded-for'] || req.socket.remoteAddress || '');

    res.json({
      ok: true, name: student.name, time,
      isLate: record.isLate, minutesLate: record.minutesLate,
    });
  } catch (e) {
    logError(e.message, req);
    res.status(500).json({ error: 'Временная ошибка' });
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
  try {
    res.json({
      summary:  db.getTodaySummary(config.TIMEZONE),
      chart:    db.getAttendanceByDays(config.TIMEZONE, 7),
      wa:       wa.getStatus(),
      email:    em.getStatus(),
      students: db.countStudents(),
      groups:   db.countGroups(),
    });
  } catch (e) { logError('dashboard: ' + e.message, req); res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════
// API: ГРУППЫ
// ═══════════════════════════════════════════════════
app.get('/api/groups', (req, res) => {
  try { res.json(db.getGroups()); }
  catch (e) { logError('groups: ' + e.message, req); res.status(500).json({ error: e.message }); }
});

app.post('/api/groups', (req, res) => {
  const errs = validateGroup(req.body);
  if (errs) return res.status(400).json({ error: errs[0], errors: errs });
  const { name, lessonStartTime, lateMinutes } = req.body;
  const g = db.addGroup({ name: name.trim(), lessonStartTime: lessonStartTime || '', lateMinutes: Number(lateMinutes) || 10 });
  db.audit('create', 'group', g.id, g.name, req.adminIp);
  res.json(g);
});

app.put('/api/groups/:id', (req, res) => {
  try {
    const g = db.updateGroup(req.params.id, req.body);
    db.audit('update', 'group', req.params.id, JSON.stringify(req.body), req.adminIp);
    res.json(g);
  } catch (e) { logError('updateGroup: ' + e.message, req); res.status(500).json({ error: e.message }); }
});

app.delete('/api/groups/:id', (req, res) => {
  try {
    db.audit('delete', 'group', req.params.id, '', req.adminIp);
    db.deleteGroup(req.params.id);
    res.json({ ok: true });
  } catch (e) { logError('deleteGroup: ' + e.message, req); res.status(500).json({ error: e.message }); }
});

app.post('/api/groups/:id/duplicate', (req, res) => {
  try {
    const src = db.findGroup(req.params.id);
    if (!src) return res.status(404).json({ error: 'Не найдена' });
    const g = db.addGroup({ name: src.name + ' (копия)', lessonStartTime: src.lessonStartTime, lateMinutes: src.lateMinutes });
    db.audit('duplicate', 'group', g.id, src.name, req.adminIp);
    res.json(g);
  } catch (e) { logError('duplicateGroup: ' + e.message, req); res.status(500).json({ error: e.message }); }
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
      await em.send(s.parentEmail, `[${config.SCHOOL_NAME}] Сообщение от педагога`,
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
  try {
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
  } catch (e) { logError('students: ' + e.message, req); res.status(500).json({ error: e.message }); }
});

app.post('/api/students', (req, res) => {
  const errs = validateStudent(req.body);
  if (errs) return res.status(400).json({ error: errs[0], errors: errs });
  const { name, parentPhone, parentName, parentEmail, telegramChatId, groupId, consentDate } = req.body;
  const s = db.addStudent({ name: name.trim(), parentPhone, parentName, parentEmail, telegramChatId, groupId, consentDate });
  const parentUrl = `${config.BASE_URL}/parent/${db.getOrCreateParentToken(s.id)}`;
  db.audit('create', 'student', s.id, s.name, req.adminIp);
  res.json({ ...s, parentUrl });
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
  try { res.json(db.getAttendance(200, req.query.groupId || null, req.query.from || null, req.query.to || null)); }
  catch (e) { logError('attendance: ' + e.message, req); res.status(500).json({ error: e.message }); }
});

app.get('/api/attendance/export', async (req, res) => {
  try {
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
  } catch (e) { logError('export: ' + e.message, req); res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════
// API: QR ГРУППЫ
// ═══════════════════════════════════════════════════
app.get('/api/groups/:id/qr', async (req, res) => {
  const group = db.findGroup(req.params.id);
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });
  const url = `${config.BASE_URL}/g/${group.id}`;
  res.json({
    qrImage: await QRCode.toDataURL(url, { width: 400, margin: 2 }),
    url,
    group,
    students: db.getStudents(group.id).map(s => ({ id: s.id, name: s.name, pin: s.pin })),
  });
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
    await wa.sendDirect(phone, `[${config.SCHOOL_NAME}] ✅ Тестовое сообщение от системы посещаемости. Всё работает!`);
    db.audit('test_wa', 'whatsapp', '', phone, req.adminIp);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Baileys: QR-код для авторизации
app.get('/api/whatsapp/qr', (req, res) => {
  const qr = wa.getQR();
  res.json({ qr });
});

// Baileys: выход из WhatsApp
app.post('/api/whatsapp/logout', async (req, res) => {
  try {
    await wa.logout();
    db.audit('wa_logout', 'whatsapp', '', '', req.adminIp);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Baileys: перезапуск подключения
app.post('/api/whatsapp/restart', async (req, res) => {
  try {
    await wa.restart();
    db.audit('wa_restart', 'whatsapp', '', '', req.adminIp);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/telegram/status', async (req, res) => res.json(await tg.getStatus()));

app.post('/api/telegram/test', async (req, res) => {
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'Укажите chat_id' });
  try {
    await tg.sendMessage(chatId, `[<b>${esc(config.SCHOOL_NAME)}</b>] ✅ Тестовое сообщение от системы посещаемости. Всё работает!`);
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
app.get('/api/audit', (req, res) => {
  try { res.json(db.getAuditLog(200)); }
  catch (e) { logError('audit: ' + e.message, req); res.status(500).json({ error: e.message }); }
});

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
app.get('/admin',   (req, res) => res.sendFile('index.html',   { root: 'public' }));
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

function groupScanPage(group) {
  const school = esc(config.SCHOOL_NAME);
  const groupName = esc(group.name);
  return `<!DOCTYPE html><html lang="ru"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#667eea">
<title>${groupName} — ${school}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);
     min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:24px;padding:40px 32px;text-align:center;
      box-shadow:0 20px 60px rgba(0,0,0,.2);max-width:380px;width:100%}
.icon{font-size:56px;margin-bottom:12px}
h2{font-size:22px;color:#1a1a2e;margin-bottom:4px}
.school{font-size:13px;color:#aaa;margin-bottom:20px}
.pin-input{width:100%;font-size:32px;text-align:center;letter-spacing:12px;padding:16px;
           border:2px solid #e0e0e0;border-radius:16px;outline:none;font-weight:700}
.pin-input:focus{border-color:#667eea;box-shadow:0 0 0 3px rgba(102,126,234,.2)}
.btn{width:100%;padding:16px;margin-top:16px;background:linear-gradient(135deg,#667eea,#764ba2);
     color:#fff;border:none;border-radius:16px;font-size:18px;font-weight:600;cursor:pointer}
.btn:active{transform:scale(.98)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.msg{margin-top:16px;padding:12px;border-radius:12px;font-size:15px;display:none}
.msg.ok{display:block;background:#e8f5e9;color:#2e7d32}
.msg.err{display:block;background:#fce4ec;color:#c62828}
.msg.warn{display:block;background:#fff3e0;color:#e65100}
.late-msg{color:#e53935;font-weight:600;margin-top:4px}
footer{margin-top:20px;font-size:11px;color:rgba(255,255,255,.5)}
footer a{color:rgba(255,255,255,.7);text-decoration:none}
</style></head><body>
<div class="card">
  <div class="icon">🎓</div>
  <h2>${groupName}</h2>
  <p class="school">${school}</p>
  <form id="f" autocomplete="off">
    <input class="pin-input" id="pin" type="tel" maxlength="6" placeholder="000000" inputmode="numeric" pattern="[0-9]*" autofocus>
    <button class="btn" type="submit" id="btn">Отметиться</button>
  </form>
  <div class="msg" id="msg"></div>
</div>
<footer><a href="/privacy">Политика конфиденциальности</a> · <a href="/help">Помощь</a></footer>
<script>
const f=document.getElementById('f'),pin=document.getElementById('pin'),btn=document.getElementById('btn'),msg=document.getElementById('msg');
pin.addEventListener('input',()=>{pin.value=pin.value.replace(/\\D/g,'');msg.className='msg';msg.style.display='none'});
f.addEventListener('submit',async e=>{
  e.preventDefault();
  if(pin.value.length<4)return; // поддержка 4 и 6 цифр
  btn.disabled=true;btn.textContent='...';msg.style.display='none';
  try{
    const r=await fetch('/g/${group.id}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:pin.value})});
    const d=await r.json();
    if(d.already){
      msg.className='msg warn';msg.innerHTML='✅ <b>'+d.name+'</b><br>Уже отмечен(а). Приход: '+d.time;
    }else if(d.ok){
      let t='✅ <b>'+d.name+'</b><br>Приход: '+d.time;
      if(d.isLate)t+='<br><span class="late-msg">⚠️ Опоздание: '+d.minutesLate+' мин</span>';
      t+='<br><small style="color:#27ae60">📨 Уведомление отправлено</small>';
      msg.className='msg ok';msg.innerHTML=t;
    }else{
      msg.className='msg err';msg.textContent=d.error||'Ошибка';
    }
    msg.style.display='block';
  }catch(e){msg.className='msg err';msg.textContent='Ошибка сети';msg.style.display='block'}
  btn.disabled=false;btn.textContent='Отметиться';pin.value='';pin.focus();
});
</script>
</body></html>`;
}
