/**
 * Напоминания за 1 час до занятия
 *
 * Каждую минуту проверяет все группы. Если до начала занятия осталось
 * от 59 до 61 минуты — отправляет напоминание родителям через все каналы.
 * Дубликаты предотвращаются через Set с ключом "groupId:YYYY-MM-DD".
 */
'use strict';
const db     = require('./db');
const wa     = require('./whatsapp');
const tg     = require('./telegram');
const em     = require('./email');
const config = require('./config');

// Хранение уже отправленных напоминаний (groupId:дата)
const _sent = new Set();
let _timer  = null;

function start() {
  if (_timer) return;
  // Проверяем каждую минуту
  _timer = setInterval(_check, 60 * 1000);
  _timer.unref?.();
  // Первая проверка сразу
  _check();
  console.log('⏰ Напоминания о занятиях: запущены (за 1 час)');
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

function _check() {
  try {
    const groups = db.getGroups();
    for (const group of groups) {
      if (!group.lessonStartTime) continue;
      const minutesUntil = _minutesUntilLesson(group.lessonStartTime);
      // Окно: от 59 до 61 минуты до занятия
      if (minutesUntil >= 59 && minutesUntil <= 61) {
        const today = _todayKey();
        const key = `${group.id}:${today}`;
        if (_sent.has(key)) continue;
        _sent.add(key);
        _sendReminders(group);
      }
    }
    // Чистим старые ключи (оставляем только сегодня)
    const today = _todayKey();
    for (const key of _sent) {
      if (!key.endsWith(':' + today)) _sent.delete(key);
    }
  } catch (e) {
    console.error('❌ Reminders check:', e.message);
  }
}

function _sendReminders(group) {
  const students = db.getStudents(group.id);
  if (!students.length) return;

  const school = config.SCHOOL_NAME;
  const time   = group.lessonStartTime;
  let sent = 0;

  for (const s of students) {
    if (!s.isActive) continue;
    const name = s.parentName || 'Родитель';

    // WhatsApp
    if (s.parentPhone) {
      wa.send(s.parentPhone,
        `[${school}]\n👋 ${name}, напоминаем!\n\n📚 ${s.name} — занятие через 1 час.\n🏫 Группа: ${group.name}\n🕐 Начало: ${time}`,
        s.name + ' (напоминание)');
      sent++;
    }

    // Telegram
    if (s.telegramChatId && !s.telegramStopAt) {
      const esc = _esc;
      tg.sendMessage(s.telegramChatId,
        `[<b>${esc(school)}</b>]\n👋 ${esc(name)}, напоминаем!\n\n📚 <b>${esc(s.name)}</b> — занятие через 1 час.\n🏫 Группа: ${esc(group.name)}\n🕐 Начало: <b>${time}</b>`
      ).catch(e => console.error('TG reminder:', e.message));
      sent++;
    }

    // Email
    if (s.parentEmail) {
      em.send(s.parentEmail, `[${school}] Напоминание: занятие через 1 час`,
        `<p>👋 ${_esc(name)},</p>
         <p>📚 <b>${_esc(s.name)}</b> — занятие через 1 час.</p>
         <p>🏫 Группа: ${_esc(group.name)}<br>🕐 Начало: <b>${time}</b></p>`
      ).catch(e => console.error('Email reminder:', e.message));
      sent++;
    }
  }

  if (sent > 0) {
    db.audit('reminder', 'group', group.id, `${group.name}: ${sent} напоминаний`, 'system');
    console.log(`⏰ Напоминание: ${group.name} (${time}) — ${sent} уведомлений`);
  }
}

/**
 * Сколько минут осталось до lessonStartTime (в часовом поясе учебного центра)
 */
function _minutesUntilLesson(lessonTime) {
  const [hh, mm] = lessonTime.split(':').map(Number);
  if (isNaN(hh) || isNaN(mm)) return -1;

  let nowH, nowM;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: config.TIMEZONE, hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(new Date());
    nowH = Number(parts.find(p => p.type === 'hour').value);
    nowM = Number(parts.find(p => p.type === 'minute').value);
  } catch {
    const now = new Date();
    nowH = now.getHours();
    nowM = now.getMinutes();
  }

  const lessonMin = hh * 60 + mm;
  const nowMin    = nowH * 60 + nowM;
  const diff      = lessonMin - nowMin;

  // Если разница отрицательная, занятие уже прошло сегодня
  return diff >= 0 ? diff : -1;
}

function _todayKey() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: config.TIMEZONE,
      year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch { return new Date().toISOString().slice(0, 10); }
}

function _esc(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { start, stop };
