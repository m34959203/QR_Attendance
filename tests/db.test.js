/**
 * Unit-тесты для db.js
 * Запуск: npm test
 */
'use strict';

// Мокаем config.js чтобы тесты не зависели от .env
jest.mock('../src/config', () => ({
  TIMEZONE: 'Asia/Almaty',
}));

const db = require('../src/db');

beforeAll(async () => {
  await db.init();
});

// ═══════════════════════════════════════════════════
// ГРУППЫ
// ═══════════════════════════════════════════════════
describe('Groups', () => {
  let groupId;

  test('addGroup — создаёт группу с корректными полями', () => {
    const g = db.addGroup({ name: 'Тест 7А', lessonStartTime: '09:00', lateMinutes: 5 });
    expect(g).toHaveProperty('id');
    expect(g.name).toBe('Тест 7А');
    expect(g.lessonStartTime).toBe('09:00');
    expect(g.lateMinutes).toBe(5);
    groupId = g.id;
  });

  test('getGroups — возвращает массив с созданной группой', () => {
    const groups = db.getGroups();
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.some(g => g.id === groupId)).toBe(true);
  });

  test('findGroup — находит группу по id', () => {
    const g = db.findGroup(groupId);
    expect(g).not.toBeNull();
    expect(g.name).toBe('Тест 7А');
  });

  test('updateGroup — обновляет название', () => {
    const g = db.updateGroup(groupId, { name: 'Тест 7Б' });
    expect(g.name).toBe('Тест 7Б');
  });

  test('updateGroup — игнорирует неразрешённые поля', () => {
    const g = db.updateGroup(groupId, { hack: 'DROP TABLE' });
    expect(g.name).toBe('Тест 7Б');
  });

  test('deleteGroup — удаляет группу', () => {
    db.deleteGroup(groupId);
    expect(db.findGroup(groupId)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════
// УЧЕНИКИ
// ═══════════════════════════════════════════════════
describe('Students', () => {
  let studentId;
  let groupId;

  beforeAll(() => {
    const g = db.addGroup({ name: 'Группа для учеников' });
    groupId = g.id;
  });

  test('addStudent — создаёт ученика с очисткой телефона', () => {
    const s = db.addStudent({
      name: 'Алия Иванова',
      parentPhone: '+7(700)123-45-67',
      parentName: 'Гульнара',
      parentEmail: '  Test@Example.COM ',
      groupId,
    });
    expect(s).toHaveProperty('id');
    expect(s.name).toBe('Алия Иванова');
    expect(s.parentPhone).toBe('77001234567');
    expect(s.parentEmail).toBe('test@example.com');
    expect(s.isActive).toBe(1);
    studentId = s.id;
  });

  test('findStudent — находит ученика по id', () => {
    const s = db.findStudent(studentId);
    expect(s).not.toBeNull();
    expect(s.name).toBe('Алия Иванова');
  });

  test('getStudents — возвращает активных учеников', () => {
    const students = db.getStudents();
    expect(students.some(s => s.id === studentId)).toBe(true);
  });

  test('getStudents — фильтрация по группе', () => {
    const students = db.getStudents(groupId);
    expect(students.length).toBeGreaterThan(0);
    expect(students.every(s => s.groupId === groupId)).toBe(true);
  });

  test('updateStudent — обновляет имя', () => {
    const s = db.updateStudent(studentId, { name: 'Алия Петрова' });
    expect(s.name).toBe('Алия Петрова');
  });

  test('updateStudent — sanitize телефона при обновлении', () => {
    const s = db.updateStudent(studentId, { parentPhone: '+7-700-999-88-77' });
    expect(s.parentPhone).toBe('77009998877');
  });

  test('updateStudent — игнорирует неразрешённые поля', () => {
    const before = db.findStudent(studentId);
    db.updateStudent(studentId, { createdAt: '2020-01-01', hackerField: 'drop' });
    const after = db.findStudent(studentId);
    expect(after.createdAt).toBe(before.createdAt);
  });

  test('archiveStudent — деактивирует ученика', () => {
    db.archiveStudent(studentId);
    const s = db.findStudent(studentId);
    expect(s.isActive).toBe(0);
    // Не должен быть в обычном списке
    const students = db.getStudents();
    expect(students.some(s => s.id === studentId)).toBe(false);
    // Должен быть в архивном
    const archived = db.getStudents(null, true);
    expect(archived.some(s => s.id === studentId)).toBe(true);
    // Восстановим для дальнейших тестов
    db.updateStudent(studentId, { isActive: 1 });
  });

  test('getOrCreateParentToken — возвращает 12-символьный токен', () => {
    const token = db.getOrCreateParentToken(studentId);
    expect(token).toHaveLength(12);
    expect(/^[a-f0-9]+$/.test(token)).toBe(true);
  });

  test('findStudentByToken — находит ученика по токену', () => {
    const token = db.getOrCreateParentToken(studentId);
    const s = db.findStudentByToken(token);
    expect(s).not.toBeNull();
    expect(s.id).toBe(studentId);
  });

  test('findStudentByToken — возвращает null для неверного токена', () => {
    expect(db.findStudentByToken('000000000000')).toBeNull();
    expect(db.findStudentByToken(null)).toBeNull();
    expect(db.findStudentByToken('short')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════
// ПОСЕЩАЕМОСТЬ
// ═══════════════════════════════════════════════════
describe('Attendance', () => {
  let studentId;

  beforeAll(() => {
    const g = db.addGroup({ name: 'Attendance тест', lessonStartTime: '09:00', lateMinutes: 5 });
    const s = db.addStudent({ name: 'Тест Ученик', groupId: g.id });
    studentId = s.id;
  });

  test('addAttendance — создаёт запись посещаемости', () => {
    const rec = db.addAttendance(studentId);
    expect(rec).not.toBeNull();
    expect(rec.studentId).toBe(studentId);
    expect(rec.studentName).toBe('Тест Ученик');
    expect(rec).toHaveProperty('isLate');
    expect(rec).toHaveProperty('time');
  });

  test('addAttendance — возвращает null для несуществующего ученика', () => {
    expect(db.addAttendance('nonexistent-id')).toBeNull();
  });

  test('getLastAttendance — возвращает последнюю запись', () => {
    const last = db.getLastAttendance(studentId);
    expect(last).not.toBeNull();
    expect(last.studentId).toBe(studentId);
  });

  test('addManualAttendance — создаёт запись с причиной', () => {
    const rec = db.addManualAttendance(studentId, 'sick');
    expect(rec.reason).toBe('sick');
    expect(rec.isLate).toBe(0);
  });

  test('getAttendance — возвращает записи', () => {
    const records = db.getAttendance(10);
    expect(Array.isArray(records)).toBe(true);
    expect(records.length).toBeGreaterThan(0);
  });

  test('getStudentStats — возвращает помесячную статистику', () => {
    const stats = db.getStudentStats(studentId, 6);
    expect(Array.isArray(stats)).toBe(true);
    expect(stats.length).toBeGreaterThan(0);
    expect(stats[0]).toHaveProperty('month');
    expect(stats[0]).toHaveProperty('total');
    expect(stats[0]).toHaveProperty('late');
  });

  test('getStudentAttendance — возвращает записи ученика', () => {
    const records = db.getStudentAttendance(studentId, 10);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every(r => r.studentId === studentId)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════
// ДАШБОРД
// ═══════════════════════════════════════════════════
describe('Dashboard', () => {
  test('getTodaySummary — возвращает корректную структуру', () => {
    const summary = db.getTodaySummary('Asia/Almaty');
    expect(summary).toHaveProperty('total');
    expect(summary).toHaveProperty('present');
    expect(summary).toHaveProperty('late');
    expect(summary).toHaveProperty('today');
    expect(typeof summary.total).toBe('number');
  });

  test('getAttendanceByDays — возвращает массив за N дней', () => {
    const chart = db.getAttendanceByDays('Asia/Almaty', 7);
    expect(chart).toHaveLength(7);
    expect(chart[0]).toHaveProperty('date');
    expect(chart[0]).toHaveProperty('present');
    expect(chart[0]).toHaveProperty('late');
  });
});

// ═══════════════════════════════════════════════════
// АУДИТ
// ═══════════════════════════════════════════════════
describe('Audit', () => {
  test('audit — записывает действие', () => {
    db.audit('test_action', 'test_entity', 'test-id', 'test details', '127.0.0.1');
    const logs = db.getAuditLog(1);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('test_action');
    expect(logs[0].entity).toBe('test_entity');
    expect(logs[0].ip).toBe('127.0.0.1');
  });
});

// ═══════════════════════════════════════════════════
// GDPR
// ═══════════════════════════════════════════════════
describe('GDPR', () => {
  test('gdprDeleteStudent — полностью удаляет ученика и посещаемость', () => {
    const s = db.addStudent({ name: 'GDPR Test' });
    db.addAttendance(s.id);
    db.addAttendance(s.id);

    const deleted = db.gdprDeleteStudent(s.id);
    expect(deleted.name).toBe('GDPR Test');
    expect(db.findStudent(s.id)).toBeNull();
    expect(db.getLastAttendance(s.id)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════
// АВТООЧИСТКА
// ═══════════════════════════════════════════════════
describe('AutoCleanup', () => {
  test('autoCleanup — не удаляет при retentionYears=0', () => {
    expect(db.autoCleanup(0)).toBe(0);
  });

  test('autoCleanup — не удаляет свежие записи', () => {
    expect(db.autoCleanup(1)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════
// ВАЛИДАЦИЯ
// ═══════════════════════════════════════════════════
describe('Validate module', () => {
  const { validateStudent, validateGroup, validatePhone, validateMessage } = require('../src/validate');

  test('validateStudent — пропускает валидные данные', () => {
    expect(validateStudent({ name: 'Тест' })).toBeNull();
    expect(validateStudent({ name: 'Тест', parentPhone: '77001234567', parentEmail: 'a@b.com' })).toBeNull();
  });

  test('validateStudent — отклоняет пустое имя', () => {
    const errs = validateStudent({ name: '' });
    expect(errs).not.toBeNull();
    expect(errs[0]).toMatch(/имя/i);
  });

  test('validateStudent — отклоняет неверный телефон', () => {
    const errs = validateStudent({ name: 'Тест', parentPhone: '123' });
    expect(errs).not.toBeNull();
    expect(errs[0]).toMatch(/телефон/i);
  });

  test('validateStudent — отклоняет неверный email', () => {
    const errs = validateStudent({ name: 'Тест', parentEmail: 'notanemail' });
    expect(errs).not.toBeNull();
    expect(errs[0]).toMatch(/email/i);
  });

  test('validateGroup — пропускает валидные данные', () => {
    expect(validateGroup({ name: 'Группа' })).toBeNull();
    expect(validateGroup({ name: 'Группа', lessonStartTime: '09:00', lateMinutes: 10 })).toBeNull();
  });

  test('validateGroup — отклоняет неверное время', () => {
    const errs = validateGroup({ name: 'Группа', lessonStartTime: '9am' });
    expect(errs).not.toBeNull();
  });

  test('validatePhone — проверяет формат', () => {
    expect(validatePhone('77001234567')).toBeNull();
    expect(validatePhone('')).not.toBeNull();
    expect(validatePhone('123')).not.toBeNull();
  });

  test('validateMessage — проверяет пустоту и длину', () => {
    expect(validateMessage('Привет')).toBeNull();
    expect(validateMessage('')).not.toBeNull();
    expect(validateMessage('a'.repeat(5000))).not.toBeNull();
  });
});
