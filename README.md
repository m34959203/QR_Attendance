# QR Attendance — Система посещаемости для кружков и учебных центров

<div align="center">

**Ученик сканирует QR → вводит PIN → родитель получает WhatsApp / Telegram / Email уведомление**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-5-black)](https://expressjs.com)
[![SQLite](https://img.shields.io/badge/DB-SQLite-blue)](https://sql.js.org)
[![Version](https://img.shields.io/badge/version-1.2.0-blue)](CHANGELOG.md)
[![License: ISC](https://img.shields.io/badge/License-ISC-yellow)](LICENSE)

</div>

---

## Что делает система

1. Распечатайте QR-код группы — повесьте у входа в кабинет
2. Ученик наводит камеру на QR → вводит свой 4-значный PIN
3. Родителю мгновенно приходит уведомление:

```
[Робототехника Almaty]
👋 Здравствуйте, Гульнара апай!

✅ Алия Иванова пришла на занятие.
🕐 15:07
📅 среда, 11 марта
```

4. За 1 час до занятия — автоматическое напоминание родителям

Никаких приложений. Никакой регистрации. Просто камера телефона.

---

## Возможности

| Функция | Описание |
|---|---|
| 📱 QR + PIN | QR группы + индивидуальный PIN ученика |
| 📲 WhatsApp | Baileys (бесплатно), Green API, Twilio, WWebJS |
| 📨 Telegram | Bot API — Webhook или Long Polling |
| 📧 Email | SMTP — Gmail, Yandex, Mail.ru |
| ⏰ Напоминания | Автоуведомление за 1 час до занятия |
| 📚 Группы | Несколько кружков с индивидуальными расписаниями |
| ⏰ Опоздание | Автоопределение и уведомление |
| 📋 Журнал | История с фильтрами по группе и дате |
| 📊 Статистика | По ученику за 6 месяцев |
| 📥 Excel-экспорт | С фильтром по группе и дате |
| 👨‍👩‍👧 Кабинет родителя | `/parent/:token` — история посещений |
| 🖨 Печать QR + PIN | Все коды группы одной кнопкой |
| ✏️ Ручная отметка | «Болен» / «Уважительная причина» |
| 📢 Рассылка | Сообщение всем родителям группы |
| 🔍 Аудит-лог | Все изменения данных фиксируются |
| 🗑 GDPR | Полное удаление данных по запросу |
| 🔒 Безопасность | Helmet, CSRF, timing-safe auth, rate limiting |
| 🐳 Docker | Hardened: non-root, healthcheck |

---

## Быстрый старт

```bash
git clone <repo-url> && cd qr-attendance
npm install
cp .env.example .env
# Заполните .env (BASE_URL, ADMIN_PASSWORD, SCHOOL_NAME)
npm start
```

Открыть: **http://localhost:3000/admin**

---

## Конфигурация `.env`

| Переменная | Обязательно | Описание |
|---|:---:|---|
| `BASE_URL` | ✅ | Публичный URL — записывается в QR-коды |
| `ADMIN_PASSWORD` | ✅ | Пароль панели педагога |
| `SCHOOL_NAME` | — | Название в уведомлениях (по умолч. «Учебный центр») |
| `TIMEZONE` | — | Часовой пояс (по умолч. `Asia/Almaty`) |
| `WA_PROVIDER` | — | `baileys` (по умолч.), `greenapi`, `twilio`, `wwebjs` |
| `GREEN_API_INSTANCE_ID` | WA | ID инстанса Green API |
| `GREEN_API_TOKEN` | WA | Токен Green API |
| `TELEGRAM_BOT_TOKEN` | TG | Токен от @BotFather |
| `SMTP_HOST` | Email | SMTP хост (smtp.gmail.com) |
| `SMTP_PORT` | Email | SMTP порт (465 / 587) |
| `SMTP_USER` | Email | Email аккаунт |
| `SMTP_PASS` | Email | Пароль приложения |
| `DATA_RETENTION_YEARS` | — | Срок хранения (лет, `0` = бессрочно) |

> ⚠️ `.env` добавлен в `.gitignore` — никогда не коммитьте его.

### BASE_URL по среде

| Среда | Значение |
|---|---|
| Локальный Wi-Fi | `http://192.168.1.100:3000` |
| VPS | `http://1.2.3.4:3000` |
| VPS + домен + SSL | `https://club.example.kz` |
| Ngrok (тест) | `https://xxxx.ngrok.io` |

---

## WhatsApp

### Baileys (бесплатный, по умолчанию)

1. Запустите сервер → откройте панель → вкладка «WhatsApp»
2. Отсканируйте QR-код в WhatsApp → «Связанные устройства»
3. Готово — сообщения отправляются напрямую

### Green API (платный)

1. Зарегистрируйтесь на [green-api.com](https://green-api.com)
2. Создайте инстанс → подключите WhatsApp через QR
3. Скопируйте `idInstance` и `apiTokenInstance` в `.env`
4. Установите `WA_PROVIDER=greenapi`

### Twilio

1. Зарегистрируйтесь на [twilio.com](https://twilio.com)
2. Настройте WhatsApp Sandbox или Business Profile
3. Заполните `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`
4. Установите `WA_PROVIDER=twilio`

**Проверка:** Панель → вкладка «📱 WhatsApp» → «Отправить тест».

---

## Telegram

1. [@BotFather](https://t.me/BotFather) → `/newbot` → скопируйте токен в `.env`
2. Перезапустите — Webhook установится автоматически (на VPS с HTTPS)
3. На localhost — автоматически Long Polling

**Привязка родителя:** Родитель пишет боту `/start` → получает chat_id → передаёт педагогу → педагог вводит в карточку ученика.

---

## Email (SMTP)

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=your@gmail.com
SMTP_PASS=your_app_password
```

> Для Gmail: включите 2FA и создайте «Пароль приложения» в настройках безопасности.

---

## Деплой

### PM2

```bash
npm i -g pm2
pm2 start src/server.js --name qr-attendance
pm2 save && pm2 startup
```

### Docker

```bash
docker compose up -d
```

Docker-образ включает:
- Non-root пользователь (`node`)
- Healthcheck (`/health` каждые 30 сек)
- `.dockerignore` для минимального образа

### nginx + HTTPS (обязательно для Telegram Webhook)

```nginx
server {
    listen 443 ssl;
    server_name club.example.kz;
    ssl_certificate     /etc/letsencrypt/live/club.example.kz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/club.example.kz/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
certbot --nginx -d club.example.kz
```

> При `BASE_URL=https://...` система автоматически перенаправляет HTTP → HTTPS.

---

## Безопасность

| Мера | Статус |
|---|---|
| Timing-safe сравнение паролей | ✅ `crypto.timingSafeEqual` |
| CSRF-защита (проверка Origin) | ✅ Для POST/PUT/DELETE |
| HTTPS redirect | ✅ Автоматический при `https://` BASE_URL |
| Helmet.js (CSP, XSS, clickjack) | ✅ |
| Rate limiting | ✅ Скан, авторизация, запись |
| Параметризованные SQL-запросы | ✅ |
| HTML escaping | ✅ Все динамические данные |
| Graceful shutdown | ✅ SIGTERM/SIGINT |
| Non-root Docker | ✅ |

Подробнее: [SECURITY.md](SECURITY.md)

---

## Миграция с v1.0.0 (db.json → SQLite)

```bash
node migrate.js
```

---

## Структура проекта

```
qr-attendance/
├── src/
│   ├── server.js              # Точка входа, Express, маршруты, graceful shutdown
│   ├── db.js                  # База данных (SQLite через sql.js)
│   ├── config.js              # Настройки из .env
│   ├── whatsapp.js            # WhatsApp фасад (4 провайдера)
│   ├── telegram.js            # Telegram Bot (Webhook/Polling)
│   ├── email.js               # SMTP уведомления (nodemailer)
│   ├── reminders.js           # Напоминания за 1 час до занятия
│   ├── message-queue.js       # Очередь WA с повторными попытками
│   ├── cleanup.js             # Ночная очистка данных
│   ├── validate.js            # Валидация входных данных API
│   └── whatsapp-providers/
│       ├── baileys.js         # Baileys (бесплатный, прямое подключение)
│       ├── green-api.js       # Green API
│       ├── twilio.js          # Twilio
│       └── whatsapp-web.js    # WhatsApp Web.js
├── public/
│   ├── index.html             # Панель педагога (10 вкладок, SPA)
│   ├── privacy.html           # Политика конфиденциальности
│   ├── help.html              # Помощь для родителей
│   └── robots.txt
├── docs/
│   ├── API.md                 # REST API справочник
│   ├── ARCHITECTURE.md        # Архитектура системы
│   ├── DATABASE.md            # Схема базы данных
│   └── DEPLOYMENT.md          # Руководство по деплою
├── data/                      # Данные (в .gitignore)
├── .env.example
├── .dockerignore
├── migrate.js
├── Dockerfile
├── docker-compose.yml
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
└── CLAUDE.md
```

---

## Документация

| Файл | Описание |
|---|---|
| [docs/API.md](docs/API.md) | REST API — все эндпоинты с примерами |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Архитектура и компоненты |
| [docs/DATABASE.md](docs/DATABASE.md) | Схема БД, миграции, индексы |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Полное руководство по деплою |
| [CHANGELOG.md](CHANGELOG.md) | История версий |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Участие в разработке |
| [SECURITY.md](SECURITY.md) | Безопасность и GDPR |
| [CLAUDE.md](CLAUDE.md) | Контекст для Claude Code |

---

## Лицензия

[ISC](LICENSE)
