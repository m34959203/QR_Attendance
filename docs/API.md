# REST API справочник

Версия: 1.2.0

Все защищённые маршруты требуют HTTP Basic Auth (`Authorization: Basic base64(user:password)`).

---

## Публичные маршруты

### `GET /g/:groupId`
Страница сканирования QR группы — ученик вводит 4-значный PIN.

### `POST /g/:groupId`
Подтверждение прихода по PIN.

**Body:** `{ "pin": "1234" }`

**Response:**
```json
{ "ok": true, "name": "Алия Иванова", "time": "15:07", "isLate": false, "minutesLate": 0 }
```

Если уже отмечен (< 10 мин):
```json
{ "already": true, "name": "Алия Иванова", "time": "15:02" }
```

### `GET /parent/:token`
Кабинет родителя — история последних 30 посещений, статистика за 3 месяца.
Token = первые 12 hex-символов UUID ученика.

### `POST /telegram-webhook`
Входящие обновления от Telegram Bot API. Тело: стандартный Telegram Update object.

### `GET /health`
```json
{ "status": "ok", "db": true, "uptime": 3600, "ts": "2026-03-13T10:00:00.000Z" }
```

---

## Группы

### `GET /api/groups`
Список всех групп, отсортированных по имени.

### `POST /api/groups`
Создать группу.

**Body:** `{ "name": "Робототехника", "lessonStartTime": "15:00", "lateMinutes": 10 }`

### `PUT /api/groups/:id`
Обновить группу. Допустимые поля: `name`, `lessonStartTime`, `lateMinutes`.

### `DELETE /api/groups/:id`
Удалить группу. Ученики группы не удаляются.

### `POST /api/groups/:id/duplicate`
Дублировать группу с суффиксом «(копия)».

### `POST /api/groups/:id/broadcast`
Отправить сообщение всем родителям группы через WA + TG + Email.

**Body:** `{ "message": "Текст сообщения" }`

**Response:** `{ "ok": true, "sent": 15, "failed": 0 }`

### `GET /api/groups/:id/qr`
QR-код группы + список учеников с PIN-кодами.

**Response:**
```json
{
  "qrImage": "data:image/png;base64,...",
  "url": "https://club.example.kz/g/uuid",
  "group": { "id": "...", "name": "Робототехника", ... },
  "students": [{ "id": "...", "name": "Алия", "pin": "1234" }]
}
```

---

## Ученики

### `GET /api/students`
| Параметр | Тип | Описание |
|---|---|---|
| `groupId` | string | Фильтр по группе |
| `search` | string | Поиск по имени ученика/родителя/телефону |
| `archived` | `1` | Включить архивных учеников |

### `POST /api/students`
```json
{
  "name": "Алия Иванова",
  "parentPhone": "77001234567",
  "parentName": "Гульнара апай",
  "parentEmail": "parent@mail.ru",
  "telegramChatId": "123456789",
  "groupId": "uuid",
  "consentDate": "2026-03-13"
}
```
Обязательное поле: `name`. PIN генерируется автоматически (уникальный в группе).

### `POST /api/students/import`
Массовый импорт учеников.

**Body:** `{ "students": [{ "name": "...", "parentPhone": "..." }], "groupId": "uuid" }`

### `PUT /api/students/:id`
Обновить ученика. Допустимые поля: `name`, `parentPhone`, `parentName`, `parentEmail`, `telegramChatId`, `groupId`, `consentDate`, `isActive`, `telegramStopAt`.

### `DELETE /api/students/:id`
Удалить ученика (без удаления посещаемости).

### `DELETE /api/students/:id/gdpr`
**Полное GDPR удаление** — ученик + вся его посещаемость. Необратимо.

### `POST /api/students/:id/archive`
Архивировать (скрыть из основного списка, данные сохраняются).

### `GET /api/students/:id/stats`
Статистика за 6 месяцев: `[{ "month": "2026-03", "total": 12, "late": 2, "onTime": 10 }]`

### `POST /api/students/:id/manual`
Ручная отметка. **Body:** `{ "reason": "sick" | "valid" }`

---

## Посещаемость

### `GET /api/attendance`
| Параметр | Описание |
|---|---|
| `groupId` | Фильтр по группе |

Возвращает последние 200 записей.

### `GET /api/attendance/export`
Скачать Excel файл. Параметры: `groupId`, `from` (YYYY-MM-DD), `to` (YYYY-MM-DD).

---

## Каналы уведомлений

### WhatsApp
| Маршрут | Описание |
|---|---|
| `GET /api/whatsapp/status` | Статус провайдера (state, provider, sent, failed, pending) |
| `GET /api/whatsapp/log` | Лог сообщений (последние 100) |
| `POST /api/whatsapp/test` | Тест: `{ "phone": "77001234567" }` |
| `GET /api/whatsapp/qr` | QR для Baileys (data URL или null) |
| `POST /api/whatsapp/logout` | Выход (только Baileys) |
| `POST /api/whatsapp/restart` | Переподключение (только Baileys) |

### Telegram
| Маршрут | Описание |
|---|---|
| `GET /api/telegram/status` | Статус бота (enabled, mode, botName) |
| `POST /api/telegram/test` | Тест: `{ "chatId": "123456789" }` |

### Email
| Маршрут | Описание |
|---|---|
| `GET /api/email/status` | Статус SMTP (ready, host, user) |
| `POST /api/email/test` | Тест: `{ "email": "test@mail.ru" }` |

---

## Система

### `GET /api/dashboard`
```json
{
  "summary": { "total": 50, "present": 12, "late": 2, "today": "2026-03-13" },
  "chart": [{ "date": "2026-03-07", "present": 8, "late": 1 }, ...],
  "wa": { "state": "authorized", ... },
  "email": { "ready": true },
  "students": 50,
  "groups": 5
}
```

### `GET /api/audit`
Последние 200 записей аудит-лога.

### `GET /api/error-log`
Последние 50 ошибок сервера (из `data/error.log`).

---

## Коды ответов

| Код | Значение |
|---|---|
| 200 | Успех |
| 400 | Ошибка валидации: `{ "error": "описание", "errors": [...] }` |
| 401 | Требуется авторизация |
| 403 | CSRF: запрос отклонён |
| 404 | Не найдено |
| 429 | Rate limit |
| 500 | Внутренняя ошибка |
| 503 | БД не готова |
