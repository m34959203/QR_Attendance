# QR Attendance — Система учёта посещаемости

<div align="center">

**Ученик сканирует QR → родитель получает WhatsApp/Telegram уведомление**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-5-black)](https://expressjs.com)
[![SQLite](https://img.shields.io/badge/DB-SQLite-blue)](https://sql.js.org)
[![Version](https://img.shields.io/badge/version-1.1.0-blue)](CHANGELOG.md)
[![License: ISC](https://img.shields.io/badge/License-ISC-yellow)](LICENSE)

</div>

---

## Что делает система

1. Распечатайте QR-коды учеников — повесьте у входа в кабинет
2. Ученик наводит камеру телефона на QR → браузер открывает страницу подтверждения
3. Родителю мгновенно приходит уведомление:

```
[Учебный центр Bilim]
👋 Здравствуйте, Гульнара апай!

✅ Алия Иванова пришла на урок.
🕐 09:07
📅 среда, 11 марта
```

Никаких приложений. Никакой регистрации. Просто камера телефона.

---

## Возможности

| Функция | Описание |
|---|---|
| 📱 QR-сканирование | Стандартная камера, без приложений |
| 📲 WhatsApp | Через Green API (бесплатно 3 мес) |
| 📨 Telegram | Bot API — Webhook или Long Polling |
| 🏫 Группы | Несколько классов с индивидуальными расписаниями |
| ⏰ Опоздание | Автоопределение и уведомление |
| 📋 Журнал | История с фильтрами по группе и дате |
| 📊 Статистика | По ученику за 6 месяцев |
| 📥 Excel-экспорт | С фильтром по группе и дате |
| 🖨 Печать QR | Все коды группы одной кнопкой |
| ✏️ Ручная отметка | «Болен» / «Уважительная причина» |
| 📢 Рассылка | Сообщение всем родителям группы |
| 🔍 Аудит-лог | Все изменения данных фиксируются |
| 🗑 GDPR | Полное удаление данных по запросу |
| 🐳 Docker | Деплой одной командой |

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
| `ADMIN_PASSWORD` | ✅ | Пароль панели учителя |
| `SCHOOL_NAME` | — | Название в уведомлениях |
| `TIMEZONE` | — | Часовой пояс (по умолч. `Asia/Almaty`) |
| `GREEN_API_INSTANCE_ID` | WA | ID инстанса Green API |
| `GREEN_API_TOKEN` | WA | Токен Green API |
| `TELEGRAM_BOT_TOKEN` | TG | Токен от @BotFather |
| `DATA_RETENTION_YEARS` | — | Срок хранения (лет, `0` = бессрочно) |

> ⚠️ `.env` добавлен в `.gitignore` — никогда не коммитьте его.

### BASE_URL по среде

| Среда | Значение |
|---|---|
| Локальный Wi-Fi | `http://192.168.1.100:3000` |
| VPS | `http://1.2.3.4:3000` |
| VPS + домен + SSL | `https://school.example.kz` |
| Ngrok (тест) | `https://xxxx.ngrok.io` |

---

## WhatsApp (Green API)

1. Зарегистрируйтесь на [green-api.com](https://green-api.com)
2. Создайте инстанс → «Сканировать QR» → подключите телефон
3. Скопируйте `idInstance` и `apiTokenInstance` в `.env`
4. Перезапустите сервер

**Проверка:** Панель → вкладка «📱 WhatsApp» → кнопка «Отправить тест».

---

## Telegram

1. [@BotFather](https://t.me/BotFather) → `/newbot` → скопируйте токен в `.env`
2. Перезапустите — Webhook установится автоматически (на VPS с HTTPS)
3. На localhost — автоматически Long Polling

**Привязка родителя:** Родитель пишет боту `/start` → получает chat_id → передаёт учителю → учитель вводит в карточку ученика.

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

### nginx + HTTPS (обязательно для Telegram Webhook)

```nginx
server {
    listen 443 ssl;
    server_name school.example.kz;
    ssl_certificate     /etc/letsencrypt/live/school.example.kz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/school.example.kz/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

```bash
certbot --nginx -d school.example.kz
```

---

## Миграция с предыдущей версии (db.json → SQLite)

```bash
node migrate.js
```

---

## Структура проекта

```
qr-attendance/
├── src/
│   ├── server.js              # Точка входа, Express, все маршруты
│   ├── db.js                  # База данных (SQLite через sql.js)
│   ├── config.js              # Настройки из .env
│   ├── whatsapp.js            # WhatsApp фасад + очередь
│   ├── telegram.js            # Telegram Bot (Webhook/Polling)
│   ├── message-queue.js       # Очередь с повторными попытками
│   ├── cleanup.js             # Ночная очистка данных
│   └── whatsapp-providers/
│       └── green-api.js       # HTTP-клиент Green API
├── public/
│   ├── index.html             # Панель учителя
│   ├── privacy.html           # Политика конфиденциальности
│   ├── help.html              # Помощь для родителей
│   └── robots.txt
├── docs/
│   ├── API.md                 # REST API справочник
│   ├── ARCHITECTURE.md        # Архитектура системы
│   ├── DATABASE.md            # Схема базы данных
│   └── DEPLOYMENT.md          # Руководство по деплою
├── data/                      # Данные (в .gitignore)
├── .env.example               # Шаблон конфигурации
├── migrate.js                 # Скрипт миграции
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
| [docs/API.md](docs/API.md) | REST API справочник |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Архитектура и компоненты |
| [docs/DATABASE.md](docs/DATABASE.md) | Схема БД |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Полное руководство по деплою |
| [CHANGELOG.md](CHANGELOG.md) | История версий |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Участие в разработке |
| [SECURITY.md](SECURITY.md) | Безопасность и GDPR |
| [CLAUDE.md](CLAUDE.md) | Контекст для Claude Code |

---

## Лицензия

[ISC](LICENSE)
