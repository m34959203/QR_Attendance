# Схема базы данных

Версия: 1.2.0

---

## Обзор

- **Движок**: SQLite через [sql.js](https://sql.js.org) (чистый JS, без нативной компиляции)
- **Файл**: `data/db.sqlite` (создаётся автоматически при первом запуске)
- **Доступ**: Только через `src/db.js` — прямое использование sql.js в других модулях запрещено
- **ID**: UUID v4 для всех сущностей
- **Время**: Все даты хранятся в UTC (ISO 8601), конвертируются при отображении через `config.TIMEZONE`

---

## Таблицы

### groups

Группы (кружки, секции).

| Столбец | Тип | По умолчанию | Описание |
|---|---|---|---|
| `id` | TEXT PK | — | UUID v4 |
| `name` | TEXT NOT NULL | — | Название группы («Робототехника пн/ср») |
| `lessonStartTime` | TEXT | `''` | Время начала занятия, формат `HH:MM` |
| `lateMinutes` | INTEGER | `10` | Порог опоздания (минуты) |
| `createdAt` | TEXT NOT NULL | — | Дата создания (ISO 8601 UTC) |

**Пример:**
```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "name": "Робототехника (пн/ср)",
  "lessonStartTime": "15:00",
  "lateMinutes": 10,
  "createdAt": "2026-03-01T10:00:00.000Z"
}
```

---

### students

Ученики и контактные данные родителей.

| Столбец | Тип | По умолчанию | Описание |
|---|---|---|---|
| `id` | TEXT PK | — | UUID v4 |
| `name` | TEXT NOT NULL | — | ФИО ученика |
| `parentPhone` | TEXT | `''` | Телефон родителя, только цифры (`77001234567`) |
| `parentName` | TEXT | `'Родитель'` | Имя родителя (для персонализации уведомлений) |
| `parentEmail` | TEXT | `''` | Email родителя (для SMTP-уведомлений) |
| `telegramChatId` | TEXT | `''` | Telegram chat_id родителя |
| `telegramStopAt` | TEXT | `''` | Дата отписки от Telegram (ISO 8601) |
| `groupId` | TEXT | `''` | FK → `groups.id` |
| `consentDate` | TEXT | `''` | Дата согласия на обработку ПД |
| `isActive` | INTEGER | `1` | `1` = активен, `0` = архивирован |
| `pin` | TEXT | `''` | 4-значный PIN (1000–9999), уникален в рамках группы |
| `createdAt` | TEXT NOT NULL | — | Дата создания (ISO 8601 UTC) |

**Особенности:**
- `parentPhone` — хранится без `+`, пробелов, скобок — только цифры
- `parentEmail` — приводится к нижнему регистру при сохранении
- `pin` — генерируется автоматически при создании ученика, уникален внутри группы
- `telegramStopAt` — заполняется при команде `/stop` от бота

---

### attendance

Записи посещаемости.

| Столбец | Тип | По умолчанию | Описание |
|---|---|---|---|
| `id` | TEXT PK | — | UUID v4 |
| `studentId` | TEXT NOT NULL | — | FK → `students.id` |
| `studentName` | TEXT NOT NULL | — | ФИО ученика (денормализовано для отчётов) |
| `groupId` | TEXT | `''` | FK → `groups.id` |
| `isLate` | INTEGER | `0` | `1` = опоздание |
| `minutesLate` | INTEGER | `0` | Минут опоздания |
| `reason` | TEXT | `''` | Причина (`Болен`, `Уважительная причина`, или пусто) |
| `time` | TEXT NOT NULL | — | Время отметки (ISO 8601 UTC) |

**Логика опоздания:**
1. При сканировании берётся `lessonStartTime` группы и `lateMinutes`
2. Разница = текущее время (в `config.TIMEZONE`) − время начала занятия
3. Если разница > `lateMinutes` → `isLate=1`, `minutesLate=N`

---

### audit_log

Журнал действий администратора.

| Столбец | Тип | По умолчанию | Описание |
|---|---|---|---|
| `id` | TEXT PK | — | UUID v4 |
| `action` | TEXT NOT NULL | — | Тип действия (см. ниже) |
| `entity` | TEXT NOT NULL | — | Тип сущности (`student`, `group`, `attendance`) |
| `entityId` | TEXT | `''` | ID сущности |
| `details` | TEXT | `''` | Подробности (произвольный текст) |
| `ip` | TEXT | `''` | IP-адрес администратора |
| `time` | TEXT NOT NULL | — | Время действия (ISO 8601 UTC) |

**Типы действий (`action`):**

| Действие | Описание |
|---|---|
| `create_student` | Создание ученика |
| `update_student` | Редактирование ученика |
| `delete_student` | Удаление ученика |
| `gdpr_delete` | GDPR-удаление (профиль + посещаемость) |
| `archive_student` | Архивирование ученика |
| `import_students` | Импорт из CSV |
| `create_group` | Создание группы |
| `update_group` | Редактирование группы |
| `delete_group` | Удаление группы |
| `duplicate_group` | Дублирование группы |
| `scan_pin` | Сканирование QR + ввод PIN |
| `manual_attendance` | Ручная отметка (болен / уваж. причина) |
| `broadcast` | Рассылка группе |
| `reminder` | Автоматическое напоминание |

---

## Индексы

```sql
CREATE INDEX idx_attendance_studentId ON attendance(studentId);
CREATE INDEX idx_attendance_time      ON attendance(time);
CREATE INDEX idx_attendance_groupId   ON attendance(groupId);
CREATE INDEX idx_students_groupId     ON students(groupId);
```

Индексы создаются при инициализации (`_migrate()`). Используется `CREATE INDEX IF NOT EXISTS`.

---

## Миграции

Миграции выполняются автоматически при каждом запуске в `db.init()` → `_migrate()`.

### Стратегия

1. **Таблицы** — `CREATE TABLE IF NOT EXISTS` (идемпотентно)
2. **Новые столбцы** — через `_col(table, column, definition)`:
   ```javascript
   _col('students', 'parentEmail', 'TEXT DEFAULT ""');
   ```
   Использует `ALTER TABLE ... ADD COLUMN`, игнорирует ошибку если столбец уже существует.

3. **PIN-генерация** — при миграции автоматически генерируются PIN для учеников без него

### Добавление нового столбца

```javascript
// В функции _migrate() в db.js:
_col('students', 'newField', 'TEXT DEFAULT ""');
```

Не нужно создавать отдельные файлы миграций — всё в одной функции.

---

## Сохранение

| Метод | Задержка | Когда |
|---|---|---|
| `_save()` | Debounce 50мс | Обычные операции (INSERT/UPDATE/DELETE) |
| `_saveNow()` | Мгновенно | Критические операции (GDPR-удаление, бэкап) |

`_save()` через debounce объединяет серию записей в один сброс на диск — оптимизация для массовых операций (импорт CSV).

---

## Бэкапы

- **Расписание**: Ежедневно в 03:00 (через `cleanup.js`)
- **Формат**: `data/backups/db_YYYY-MM-DD.sqlite`
- **Хранение**: 30 дней, затем автоматическое удаление
- **Дедупликация**: Если бэкап на сегодня уже есть — пропускается

### Ручной бэкап

```javascript
const db = require('./db');
db.backup(); // → { skipped: false, file: '/app/data/backups/db_2026-03-13.sqlite' }
```

---

## Автоочистка

- **Настройка**: `DATA_RETENTION_YEARS` в `.env` (`0` = бессрочное хранение)
- **Механизм**: Удаление записей `attendance` старше указанного срока
- **Запуск**: Ежедневно в 03:00 после бэкапа

```javascript
db.autoCleanup(retentionYears); // → количество удалённых записей
```

---

## GDPR

Полное удаление данных ученика:

```javascript
db.gdprDeleteStudent(studentId);
```

Удаляет:
1. Все записи `attendance` с данным `studentId`
2. Запись из `students`
3. Принудительный `_saveNow()`

**Важно:** Данные не подлежат восстановлению. Действие необратимо.

---

## Ограничения

| Ограничение | Причина |
|---|---|
| Однопоточный доступ | sql.js работает в одном потоке Node.js |
| Нет FK constraints | SQLite FK не включены (для совместимости) |
| `studentName` денормализован | В `attendance` хранится копия имени для отчётов |
| Нет пула соединений | Один инстанс `Database` на весь процесс |
