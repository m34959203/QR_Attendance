# Архитектура системы

Версия: 1.2.0

---

## Обзор

QR Attendance — монолитное Node.js приложение для учёта посещаемости в частных кружках и учебных центрах. Один процесс обслуживает HTTP API, WebSocket-подобные соединения (Baileys), cron-задачи и фоновую очередь сообщений.

```
┌──────────────────────────────────────────────────────────┐
│                     Клиенты                               │
│  📱 Ученик (QR+PIN)  │  💻 Педагог (SPA)  │  👨‍👩‍👧 Родитель  │
└──────────┬────────────┴──────────┬─────────┴──────┬───────┘
           │                       │                │
           ▼                       ▼                ▼
┌──────────────────────────────────────────────────────────┐
│                    Express 5 (server.js)                   │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │ Helmet  │  │Rate Limit│  │Basic Auth│  │CSRF Check │  │
│  └────┬────┘  └────┬─────┘  └────┬─────┘  └─────┬─────┘  │
│       └─────────┬──┴─────────────┴───────────────┘        │
│                 ▼                                          │
│  ┌──────────────────────────────────────────────────────┐ │
│  │              Маршруты (30+ эндпоинтов)                │ │
│  │  /g/:groupId  /api/*  /parent/:token  /health        │ │
│  └──────────────────────┬───────────────────────────────┘ │
└─────────────────────────┼─────────────────────────────────┘
                          │
        ┌─────────────────┼──────────────────┐
        ▼                 ▼                  ▼
  ┌──────────┐    ┌────────────┐    ┌──────────────┐
  │  db.js   │    │whatsapp.js │    │ telegram.js  │
  │ (SQLite) │    │  (фасад)   │    │ (Bot API)    │
  └────┬─────┘    └─────┬──────┘    └──────────────┘
       │                │
       │          ┌─────┴──────┐
       │          ▼            ▼
       │   ┌───────────┐ ┌─────────┐
       │   │msg-queue.js│ │email.js │
       │   │(очередь WA)│ │ (SMTP)  │
       │   └─────┬─────┘ └─────────┘
       │         │
       │   ┌─────┴──────────────────────┐
       │   │  whatsapp-providers/       │
       │   │  baileys │ greenapi │ ...  │
       │   └────────────────────────────┘
       │
       ├── reminders.js (каждые 60 сек)
       ├── cleanup.js   (ежедневно 03:00)
       └── validate.js  (входные данные)
```

---

## Компоненты

### server.js — HTTP сервер
- **Роль**: Точка входа, маршрутизация, middleware, IIFE запуск
- **Зависимости**: все модули
- **Инициализация**: `db.init()` → `em.init()` → `wa.init()` → `tg.init()` → `autoClean()` → `reminders.start()` → `app.listen()`
- **Shutdown**: SIGTERM/SIGINT → `reminders.stop()` → `server.close()` → `process.exit()`

### config.js — Конфигурация
- **Роль**: Единственный источник настроек. Читает `.env` через dotenv
- **Экспорт**: Объект с 15+ полями (PORT, BASE_URL, TIMEZONE, пароли, токены)
- **Особенность**: `clean()` — санитизация от кавычек и переносов (Railway quirks)

### db.js — База данных
- **Роль**: Единственный файл с доступом к SQLite (sql.js, чистый JS)
- **Паттерн**: Функциональный модуль (не класс)
- **Сохранение**: Debounced `_save()` (50мс) для серий записей, `_saveNow()` для критических
- **Миграции**: `_migrate()` — CREATE TABLE IF NOT EXISTS + ALTER TABLE через `_col()`
- **Бэкапы**: Ежедневно, хранение 30 дней в `data/backups/`

### whatsapp.js — WhatsApp фасад
- **Роль**: Абстракция над 4 провайдерами
- **Провайдеры**: baileys (бесплатный), greenapi, twilio, wwebjs
- **Очередь**: Все сообщения через `message-queue.js` (retry: 30с → 2мин → 5мин)
- **Состояние**: `init` → `authorized` / `notAuthorized` / `error`

### telegram.js — Telegram Bot
- **Роль**: Отправка уведомлений + обработка команд бота
- **Режимы**: Webhook (VPS) / Long Polling (localhost) — автовыбор по BASE_URL
- **Команды**: `/start`, `/id`, `/stop`, `/help`

### email.js — Email уведомления
- **Роль**: SMTP отправка через nodemailer
- **Шаблоны**: HTML email с таблицей данных о приходе

### reminders.js — Напоминания
- **Роль**: За 1 час до занятия отправляет уведомления всем родителям
- **Механизм**: `setInterval(60000)` → проверка всех групп → отправка через WA/TG/Email
- **Дедупликация**: `Set<"groupId:YYYY-MM-DD">`

### cleanup.js — Ночная очистка
- **Роль**: В 03:00 — бэкап БД + удаление записей старше DATA_RETENTION_YEARS
- **Планировщик**: `setTimeout` с рекурсивным перерасчётом

### validate.js — Валидация
- **Роль**: Валидация входных данных для API
- **Функции**: `validateStudent`, `validateGroup`, `validatePhone`, `validateMessage`
- **Возврат**: `null` (ок) или `string[]` (ошибки)

---

## Поток данных: сканирование

```
Ученик → QR → GET /g/:groupId → HTML страница с PIN-формой
       → PIN → POST /g/:groupId
                ├── db.findStudentByPin(groupId, pin)
                ├── db.getLastAttendance() → проверка дубля (10 мин)
                ├── db.addAttendance() → расчёт опоздания
                ├── wa.send() → очередь → провайдер → WhatsApp родителя
                ├── tg.sendMessage() → Telegram Bot API → Telegram родителя
                ├── em.sendArrival() → SMTP → Email родителя
                └── db.audit('scan_pin', ...)
```

## Поток данных: напоминание

```
setInterval(60s) → reminders._check()
  → db.getGroups() → для каждой группы:
    → _minutesUntilLesson(lessonStartTime) → 59-61 мин?
      → _sent.has(key)? → skip
      → db.getStudents(groupId) → для каждого:
        → wa.send() + tg.sendMessage() + em.send()
      → db.audit('reminder', ...)
```

---

## Безопасность (слои)

```
Запрос → Helmet (CSP, headers)
       → Rate Limiter (IP-based)
       → HTTPS Redirect (если https:// BASE_URL)
       → Basic Auth (timing-safe)
       → CSRF Check (Origin header)
       → Валидация (validate.js)
       → Параметризованный SQL (db.js)
       → HTML Escaping (esc())
       → Ответ
```

---

## Ограничения

| Ограничение | Причина | Workaround |
|---|---|---|
| Один процесс | sql.js однопоточный | PM2 в single mode |
| Нет real-time обновлений | Нет WebSocket для UI | Ручное обновление |
| Basic Auth | Простота | HTTPS обязателен |
| Один часовой пояс | Один TIMEZONE для всех | Достаточно для одного центра |
| Нет мультитенантности | Один инстанс = один центр | Несколько Docker контейнеров |
