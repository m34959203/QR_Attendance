'use strict';
const db     = require('./db');
const config = require('./config');

function autoClean() {
  // В 03:00 по часовому поясу — очистка старых данных + бэкап
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
    const now    = new Date();
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    setTimeout(() => { try { fn(); } catch {} next(); }, target - now);
  }
  next();
}

module.exports = { autoClean };
