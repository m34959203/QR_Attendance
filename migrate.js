/**
 * Миграция данных из старого db.json (JSON-БД) в db.sqlite
 * Запуск: node migrate.js
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const db   = require('./src/db');

const JSON_DB = path.join(__dirname, 'data', 'db.json');

(async () => {
  if (!fs.existsSync(JSON_DB)) {
    console.log('❌ Файл data/db.json не найден — нечего мигрировать');
    process.exit(0);
  }

  console.log('📦 Читаю data/db.json...');
  const old = JSON.parse(fs.readFileSync(JSON_DB, 'utf-8'));
  const students = old.students || [];
  const attendance = old.attendance || [];

  await db.init();

  // Создаём группу по умолчанию
  const defaultGroup = db.addGroup({ name: 'Основная группа', lessonStartTime: '', lateMinutes: 10 });
  console.log(`✅ Создана группа: ${defaultGroup.name}`);

  // Переносим учеников
  const idMap = {}; // старый id → новый id
  let sOk = 0;
  for (const s of students) {
    try {
      const newS = db.addStudent({
        name:           s.name,
        parentPhone:    s.parentPhone || '',
        parentName:     s.parentName  || 'Родитель',
        telegramChatId: s.telegramChatId || '',
        groupId:        defaultGroup.id,
        consentDate:    '',
      });
      idMap[s.id] = newS.id;
      sOk++;
    } catch (e) {
      console.warn(`  ⚠️ Не удалось перенести ученика ${s.name}: ${e.message}`);
    }
  }
  console.log(`✅ Учеников перенесено: ${sOk} из ${students.length}`);

  // Переносим посещаемость
  let aOk = 0;
  for (const a of attendance) {
    const newStudentId = idMap[a.studentId];
    if (!newStudentId) continue;
    try {
      const SQL = require('./node_modules/sql.js');
      // Прямая вставка с сохранением оригинального времени
      db._rawInsertAttendance(newStudentId, a.studentName, defaultGroup.id, a.time);
      aOk++;
    } catch {}
  }
  console.log(`✅ Записей посещаемости перенесено: ${aOk} из ${attendance.length}`);

  // Переименовываем старый файл
  fs.renameSync(JSON_DB, JSON_DB + '.backup');
  console.log(`📁 Старый файл переименован в data/db.json.backup`);
  console.log('\n🎉 Миграция завершена!');
})();
