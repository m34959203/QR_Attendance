# QR Посещаемость — CLAUDE.md

Этот файл описывает концепцию и правила проекта для Claude Code.

## Суть проекта

Ученик сканирует QR-код телефоном у входа в класс → родитель получает уведомление в WhatsApp и/или Telegram. Без установки приложений.

---

## Стек

| Компонент | Технология |
|---|---|
| Runtime | Node.js 18+ |
| Сервер | Express 5 |
| БД | SQLite через `sql.js` (чистый JS) |
| WhatsApp | Green API — HTTP REST |
| Telegram | Bot API — Webhook (VPS) / Long Polling (localhost) |
| Excel | exceljs |
| QR | qrcode |
| UUID | uuid v4 |
| Rate limiting | express-rate-limit |
| Конфиг | dotenv |
| Фронтенд | Vanilla JS + HTML + CSS (один файл) |

---

## Структура файлов

```
src/
├── server.js          # Точка входа. IIFE-старт. Все маршруты.
├── config.js          # ЕДИНСТВЕННЫЙ источник настроек. Читает .env.
├── db.js              # ЕДИНСТВЕННЫЙ файл с доступом к SQLite.
├── whatsapp.js        # Фасад: init(), send(), sendDirect(), getStatus(), getLog()
├── message-queue.js   # Очередь WA. Повторы: 30с → 2мин → 5мин
├── telegram.js        # Webhook/Polling. init(), sendMessage(), handleWebhookUpdate()
├── cleanup.js         # Ночная очистка по DATA_RETENTION_YEARS
└── whatsapp-providers/
    └── green-api.js   # HTTP-клиент Green API

public/
├── index.html         # Вся панель (9 вкладок). Один файл.
├── privacy.html       # Политика конфиденциальности (публичная)
├── help.html          # Помощь для родителей (публичная)
└── robots.txt         # noindex на /scan/, /admin/, /api/

data/
├── db.sqlite          # База данных (создаётся автоматически)
└── message-log.json   # Лог WA-сообщений (последние 500)

.env                   # Конфигурация (в .gitignore, не коммитить!)
.env.example           # Шаблон конфигурации
migrate.js             # Миграция с 1.0.0 (JSON → SQLite)
Dockerfile
docker-compose.yml
```

---

## Схема БД (SQLite)

### groups
```sql
id TEXT PK, name TEXT, lessonStartTime TEXT, lateMinutes INTEGER, createdAt TEXT
```

### students
```sql
id TEXT PK, name TEXT, parentPhone TEXT, parentName TEXT,
telegramChatId TEXT, groupId TEXT, consentDate TEXT, isActive INTEGER, createdAt TEXT
```

### attendance
```sql
id TEXT PK, studentId TEXT, studentName TEXT, groupId TEXT,
isLate INTEGER, minutesLate INTEGER, reason TEXT, time TEXT
```

### audit_log
```sql
id TEXT PK, action TEXT, entity TEXT, entityId TEXT, details TEXT, ip TEXT, time TEXT
```

---

## API маршруты

### Публичные
- `GET /scan/:id` — сканирование QR
- `POST /telegram-webhook` — Webhook от Telegram
- `GET /health` — health check
- `GET /privacy`, `GET /help` — публичные страницы

### Защищённые (Basic Auth → /api/*)
- `GET/POST /api/groups`
- `PUT/DELETE /api/groups/:id`
- `POST /api/groups/:id/duplicate`
- `POST /api/groups/:id/broadcast`
- `GET /api/students?groupId&search&archived`
- `POST /api/students`, `POST /api/students/import`
- `PUT/DELETE /api/students/:id`
- `DELETE /api/students/:id/gdpr`
- `POST /api/students/:id/archive`
- `GET /api/students/:id/qr`
- `GET /api/students/:id/stats`
- `POST /api/students/:id/manual`
- `GET /api/attendance?groupId&from&to`
- `GET /api/attendance/export`
- `GET /api/print-all?groupId`
- `GET /api/dashboard`
- `GET /api/whatsapp/status`, `GET /api/whatsapp/log`
- `POST /api/whatsapp/test`
- `GET /api/telegram/status`, `POST /api/telegram/test`
- `GET /api/audit`

---

## Правила при разработке

1. **Вся работа с БД — только через `db.js`**
2. **WhatsApp — только через `wa.send()` или `wa.sendDirect()`**
3. **Без новых npm-зависимостей** без крайней необходимости
4. **`public/index.html` — один файл**, не дробить
5. **Телефон — только цифры**: `77001234567`
6. **Времена хранятся в UTC**, показываются в `config.TIMEZONE`
7. **`config.js` — единственный источник настроек**
8. **`db.init()` — async**, вызывается в IIFE до `app.listen()`
9. **Новые admin-действия** — фиксировать через `db.audit(action, entity, id, details, ip)`
10. **GDPR**: никогда не восстанавливать данные после `gdprDeleteStudent()`

---

## Логика опоздания

`db.addAttendance(studentId)`:
1. Найти ученика → взять `groupId`
2. Найти группу → `lessonStartTime` ("09:00") и `lateMinutes` (10)
3. Разница = текущее время - время начала урока
4. Если разница > `lateMinutes` → `isLate=1`, `minutesLate=N`
5. Уведомление родителю добавляет `⚠️ Опоздание: N мин`

---

## Telegram: Webhook vs Long Polling

Логика в `telegram.js → init()`:
- `BASE_URL` без `localhost`/`127.0.0.1` → регистрирует Webhook `${BASE_URL}/telegram-webhook`
- `BASE_URL` с localhost → Long Polling (разработка)
- Переключение автоматическое

---

## Команды

```bash
npm start          # Запуск
npm run dev        # Разработка с --watch
node migrate.js    # Миграция с v1.0.0
```

---

## Версии документации

| Документ | Версия | Файл |
|---|---|---|
| Техническое задание | 1.1.0 | ТЗ_QR_Посещаемость.docx |
| Документация разработчика | 1.1.0 | Документация_разработчика.docx |
| Руководство пользователя | 1.1.0 | Руководство_пользователя.docx |
| Changelog | — | CHANGELOG.md |
| Contributing | — | CONTRIBUTING.md |
| Security | — | SECURITY.md |
