# QR Посещаемость — CLAUDE.md

Контекст проекта для Claude Code. Описывает архитектуру, правила и контракты.

## Суть проекта

Система посещаемости для частных кружков и учебных центров. Ученик сканирует QR-код группы, вводит PIN → родитель получает уведомление в WhatsApp, Telegram и/или Email. Без установки приложений.

---

## Стек

| Компонент | Технология |
|---|---|
| Runtime | Node.js 18+ |
| Сервер | Express 5 |
| БД | SQLite через `sql.js` (чистый JS, без нативных модулей) |
| WhatsApp | 4 провайдера: Baileys (бесплатный), Green API, Twilio, WWebJS |
| Telegram | Bot API — Webhook (VPS) / Long Polling (localhost) |
| Email | nodemailer (SMTP) |
| Excel | exceljs |
| QR | qrcode |
| UUID | uuid v4 |
| Безопасность | helmet, express-rate-limit, crypto.timingSafeEqual |
| Конфиг | dotenv |
| Фронтенд | Vanilla JS + HTML + CSS (один файл) |

---

## Структура файлов

```
src/
├── server.js          # Точка входа. IIFE-старт. Все маршруты. Graceful shutdown.
├── config.js          # ЕДИНСТВЕННЫЙ источник настроек. Читает .env.
├── db.js              # ЕДИНСТВЕННЫЙ файл с доступом к SQLite.
├── whatsapp.js        # Фасад: init(), send(), sendDirect(), getStatus(), getLog()
├── message-queue.js   # Очередь WA. Повторы: 30с → 2мин → 5мин
├── telegram.js        # Webhook/Polling. init(), sendMessage(), handleWebhookUpdate()
├── email.js           # SMTP уведомления. init(), send(), sendArrival(), sendTest()
├── reminders.js       # Напоминания за 1 час до занятия (setInterval 1 мин)
├── cleanup.js         # Ночная очистка по DATA_RETENTION_YEARS (03:00)
├── validate.js        # Валидация: validateStudent, validateGroup, validatePhone, validateMessage
└── whatsapp-providers/
    ├── baileys.js     # Baileys — бесплатное прямое подключение через QR
    ├── green-api.js   # Green API — HTTP REST
    ├── twilio.js      # Twilio WhatsApp API
    └── whatsapp-web.js # WhatsApp Web.js (Puppeteer)

public/
├── index.html         # Панель педагога (10 вкладок). Один файл SPA.
├── privacy.html       # Политика конфиденциальности (публичная)
├── help.html          # Помощь для родителей (публичная)
└── robots.txt         # noindex на /scan/, /admin/, /api/

data/
├── db.sqlite          # База данных (создаётся автоматически)
├── backups/           # Ежедневные бэкапы (хранятся 30 дней)
├── message-log.json   # Лог WA-сообщений (последние 500)
└── error.log          # Лог ошибок сервера

.env                   # Конфигурация (в .gitignore, не коммитить!)
.env.example           # Шаблон конфигурации
.dockerignore          # Исключения для Docker-образа
migrate.js             # Миграция с 1.0.0 (JSON → SQLite)
Dockerfile             # Node 20 Alpine, non-root, healthcheck
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
parentEmail TEXT, telegramChatId TEXT, telegramStopAt TEXT,
groupId TEXT, consentDate TEXT, isActive INTEGER, pin TEXT, createdAt TEXT
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

### Индексы
- `idx_attendance_studentId` ON attendance(studentId)
- `idx_attendance_time` ON attendance(time)
- `idx_attendance_groupId` ON attendance(groupId)
- `idx_students_groupId` ON students(groupId)

---

## API маршруты

### Публичные
- `GET /g/:groupId` — страница сканирования QR группы (ввод PIN)
- `POST /g/:groupId` — подтверждение скана по PIN
- `GET /parent/:token` — кабинет родителя (история посещений)
- `POST /telegram-webhook` — Webhook от Telegram
- `GET /health` — health check (status, db, uptime)
- `GET /privacy`, `GET /help` — публичные страницы

### Защищённые (Basic Auth → /api/*)

#### Группы
- `GET /api/groups` — список групп
- `POST /api/groups` — создать группу
- `PUT /api/groups/:id` — редактировать
- `DELETE /api/groups/:id` — удалить
- `POST /api/groups/:id/duplicate` — дублировать
- `POST /api/groups/:id/broadcast` — рассылка родителям
- `GET /api/groups/:id/qr` — QR-код группы + список PIN

#### Ученики
- `GET /api/students?groupId&search&archived` — список учеников
- `POST /api/students` — добавить ученика
- `POST /api/students/import` — импорт из JSON/CSV
- `PUT /api/students/:id` — редактировать
- `DELETE /api/students/:id` — удалить
- `DELETE /api/students/:id/gdpr` — полное GDPR удаление
- `POST /api/students/:id/archive` — архивировать
- `GET /api/students/:id/stats` — статистика за 6 мес
- `POST /api/students/:id/manual` — ручная отметка

#### Посещаемость
- `GET /api/attendance?groupId` — журнал (последние 200)
- `GET /api/attendance/export?groupId&from&to` — Excel экспорт

#### Каналы уведомлений
- `GET /api/whatsapp/status` — статус WA провайдера
- `GET /api/whatsapp/log` — лог сообщений
- `POST /api/whatsapp/test` — тестовое сообщение
- `GET /api/whatsapp/qr` — QR для Baileys
- `POST /api/whatsapp/logout` — выход (Baileys)
- `POST /api/whatsapp/restart` — переподключение (Baileys)
- `GET /api/telegram/status` — статус TG бота
- `POST /api/telegram/test` — тестовое сообщение
- `GET /api/email/status` — статус SMTP
- `POST /api/email/test` — тестовое письмо

#### Система
- `GET /api/dashboard` — сводка (summary, chart, wa, email, counts)
- `GET /api/audit` — аудит-лог (последние 200)
- `GET /api/error-log` — лог ошибок (последние 50)

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
11. **Безопасность**: пароли через `crypto.timingSafeEqual`, HTML через `esc()`
12. **Терминология**: занятие (не урок), педагог (не учитель), группа (не класс)

---

## Логика опоздания

`db.addAttendance(studentId)`:
1. Найти ученика → взять `groupId`
2. Найти группу → `lessonStartTime` ("15:00") и `lateMinutes` (10)
3. Разница = текущее время − время начала занятия (в TIMEZONE)
4. Если разница > `lateMinutes` → `isLate=1`, `minutesLate=N`
5. Уведомление родителю добавляет `⚠️ Опоздание: N мин`

---

## Логика напоминаний

`reminders.js → _check()` (каждые 60 сек):
1. Перебирает все группы с `lessonStartTime`
2. Вычисляет минуты до занятия (в TIMEZONE)
3. Если 59–61 мин до начала → отправляет напоминание всем родителям
4. Дубликаты: Set с ключом `groupId:YYYY-MM-DD`

---

## Безопасность

| Мера | Реализация |
|---|---|
| Auth | Basic Auth + `crypto.timingSafeEqual` |
| CSRF | Проверка Origin для POST/PUT/DELETE |
| HTTPS | Автоматический редирект при `https://` BASE_URL |
| Headers | Helmet.js (CSP, X-Frame-Options, etc.) |
| Rate limit | Скан 10/мин, Auth 10/15мин, API write 60/мин |
| SQL injection | Параметризованные запросы |
| XSS | `esc()` для всех динамических данных |
| Docker | Non-root user, healthcheck |

---

## Telegram: Webhook vs Long Polling

Логика в `telegram.js → init()`:
- `BASE_URL` без `localhost`/`127.0.0.1` → Webhook `${BASE_URL}/telegram-webhook`
- `BASE_URL` с localhost → Long Polling (разработка)
- Переключение автоматическое

---

## Команды

```bash
npm start          # Запуск
npm run dev        # Разработка с --watch
npm test           # Тесты (jest)
node migrate.js    # Миграция с v1.0.0
```

---

## Версии документации

| Документ | Версия | Файл |
|---|---|---|
| Техническое задание | 1.1.0 | docs/ТЗ_QR_Посещаемость.docx |
| Документация разработчика | 1.1.0 | docs/Документация_разработчика.docx |
| Руководство пользователя | 1.1.0 | docs/Руководство_пользователя.docx |
| API справочник | 1.2.0 | docs/API.md |
| Архитектура | 1.2.0 | docs/ARCHITECTURE.md |
| Схема БД | 1.2.0 | docs/DATABASE.md |
| Деплой | 1.2.0 | docs/DEPLOYMENT.md |
| Changelog | — | CHANGELOG.md |
| Contributing | — | CONTRIBUTING.md |
| Security | — | SECURITY.md |
