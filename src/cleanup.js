'use strict';
const db     = require('./db');
const config = require('./config');

function autoClean() {
  // В 03:00 по часовому поясу учебного центра — очистка старых данных + бэкап
  _scheduleAt(3, 0, () => {
    // Бэкап
    try {
      const r = db.backup();
      if (!r.skipped) {
        console.log('💾 Бэкап БД:', r.file);
        db.audit('backup', 'db', '', r.file, 'system');
      }
    } catch (e) { console.error('❌ Backup error:', e.message); }

    // Автоудаление по сроку хранения
    if (config.DATA_RETENTION_YEARS > 0) {
      try {
        const n = db.autoCleanup(config.DATA_RETENTION_YEARS);
        if (n > 0) {
          console.log(`🧹 Автоочистка: удалено ${n} записей (>${config.DATA_RETENTION_YEARS} лет)`);
          db.audit('cleanup', 'attendance', '', `удалено: ${n}`, 'system');
        }
      } catch (e) { console.error('❌ Cleanup error:', e.message); }
    }
  });
}

function _scheduleAt(hour, minute, fn) {
  function next() {
    // Вычисляем целевое время в часовом поясе config.TIMEZONE
    const tz = config.TIMEZONE || 'UTC';
    const now = new Date();
    let nowH, nowM;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false,
      }).formatToParts(now);
      nowH = Number(parts.find(p => p.type === 'hour').value);
      nowM = Number(parts.find(p => p.type === 'minute').value);
    } catch {
      nowH = now.getHours();
      nowM = now.getMinutes();
    }
    const nowMin = nowH * 60 + nowM;
    const targetMin = hour * 60 + minute;
    let delayMin = targetMin - nowMin;
    if (delayMin <= 0) delayMin += 1440; // завтра
    setTimeout(() => { try { fn(); } catch {} next(); }, delayMin * 60 * 1000);
  }
  next();
}

module.exports = { autoClean };
