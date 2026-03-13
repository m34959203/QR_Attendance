# Руководство по деплою

Версия: 1.2.0

---

## Требования

| Компонент | Минимум | Рекомендуется |
|---|---|---|
| Node.js | 18.x | 20.x LTS |
| RAM | 128 МБ | 256 МБ |
| Диск | 100 МБ | 500 МБ (с бэкапами) |
| ОС | Linux, macOS, Windows | Linux (Ubuntu 22.04+) |

---

## Способы деплоя

### 1. Прямой запуск (VPS)

```bash
# Клонирование
git clone <repo-url> && cd qr-attendance

# Установка зависимостей
npm ci --omit=dev

# Конфигурация
cp .env.example .env
nano .env
# Обязательно: BASE_URL, ADMIN_PASSWORD
# Рекомендуется: SCHOOL_NAME, TIMEZONE

# Запуск
node src/server.js
```

---

### 2. PM2 (рекомендуется для VPS)

```bash
# Установка PM2
npm i -g pm2

# Запуск
pm2 start src/server.js --name qr-attendance

# Автозапуск при перезагрузке
pm2 save
pm2 startup
```

**PM2 конфигурация** (`ecosystem.config.js`):

```javascript
module.exports = {
  apps: [{
    name: 'qr-attendance',
    script: 'src/server.js',
    instances: 1,          // Только 1 — sql.js однопоточный
    watch: false,
    max_memory_restart: '256M',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
```

> **Важно:** Не использовать `instances: 'max'` — sql.js не поддерживает множественные процессы с одним файлом БД.

**Полезные команды:**

```bash
pm2 logs qr-attendance     # Логи
pm2 monit                   # Мониторинг
pm2 restart qr-attendance   # Перезапуск
pm2 stop qr-attendance      # Остановка
```

---

### 3. Docker

```bash
# Запуск через docker-compose
docker compose up -d

# Логи
docker compose logs -f

# Остановка
docker compose down
```

**Docker-образ включает:**
- Non-root пользователь (`node`) — безопасность
- `HEALTHCHECK` (`/health` каждые 30с)
- Минимальный образ (Alpine)
- `.dockerignore` для исключения ненужных файлов

**Персистентные данные:**

```yaml
# docker-compose.yml
volumes:
  - ./data:/app/data    # БД + бэкапы + логи
```

> Директория `data/` должна быть доступна пользователю `node` (UID 1000) внутри контейнера.

---

### 4. Railway / Render / Fly.io

Для PaaS-платформ:

1. Подключите GitHub репозиторий
2. Установите переменные окружения (`.env`)
3. Build command: `npm ci --omit=dev`
4. Start command: `node src/server.js`
5. Health check: `GET /health`

**Важно для Railway:**
- `BASE_URL` — укажите домен Railway (`https://app-name.up.railway.app`)
- Персистентный том для `data/` (иначе БД потеряется при редеплое)

---

## Настройка HTTPS

### Nginx + Let's Encrypt

```nginx
server {
    listen 80;
    server_name club.example.kz;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name club.example.kz;

    ssl_certificate     /etc/letsencrypt/live/club.example.kz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/club.example.kz/privkey.pem;

    # Безопасность
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket (для Baileys QR)
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

```bash
# Установка certbot
sudo apt install certbot python3-certbot-nginx

# Получение сертификата
sudo certbot --nginx -d club.example.kz

# Автообновление (добавляется автоматически)
sudo certbot renew --dry-run
```

### Встроенный HTTPS-редирект

При `BASE_URL=https://...` приложение автоматически перенаправляет HTTP → HTTPS через middleware. Nginx не требуется для редиректа, но рекомендуется для терминации TLS.

---

## Переменные окружения

### Обязательные

| Переменная | Пример | Описание |
|---|---|---|
| `BASE_URL` | `https://club.example.kz` | Публичный URL (записывается в QR-коды) |
| `ADMIN_PASSWORD` | `MyStr0ngP@ss` | Пароль панели педагога |

### Рекомендуемые

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `3000` | Порт HTTP-сервера |
| `SCHOOL_NAME` | `Учебный центр` | Название в уведомлениях |
| `TIMEZONE` | `Asia/Almaty` | Часовой пояс (IANA) |
| `DATA_RETENTION_YEARS` | `0` (бессрочно) | Срок хранения данных |

### WhatsApp

| Переменная | Провайдер |
|---|---|
| `WA_PROVIDER` | `baileys` (по умолч.), `greenapi`, `twilio`, `wwebjs` |
| `GREEN_API_INSTANCE_ID` | Green API |
| `GREEN_API_TOKEN` | Green API |
| `TWILIO_ACCOUNT_SID` | Twilio |
| `TWILIO_AUTH_TOKEN` | Twilio |
| `TWILIO_WHATSAPP_FROM` | Twilio |

### Telegram

| Переменная | Описание |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Токен от @BotFather |

### Email (SMTP)

| Переменная | Пример |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` (SSL) или `587` (STARTTLS) |
| `SMTP_USER` | `your@gmail.com` |
| `SMTP_PASS` | Пароль приложения |

---

## Health Check

```bash
curl http://localhost:3000/health
# → {"status":"ok"}
```

Для мониторинга (UptimeRobot, Healthchecks.io):
- **URL**: `https://club.example.kz/health`
- **Метод**: GET
- **Ожидаемый ответ**: `200 OK`, тело `{"status":"ok"}`

---

## Бэкапы

### Автоматические

Система автоматически создаёт бэкап SQLite ежедневно в 03:00:
- Файл: `data/backups/db_YYYY-MM-DD.sqlite`
- Хранение: 30 дней
- Старые бэкапы удаляются автоматически

### Ручной бэкап

```bash
# Копирование файла БД
cp data/db.sqlite data/backups/manual_$(date +%Y-%m-%d).sqlite
```

### Восстановление из бэкапа

```bash
# Остановить приложение
pm2 stop qr-attendance

# Восстановить
cp data/backups/db_2026-03-10.sqlite data/db.sqlite

# Запустить
pm2 start qr-attendance
```

---

## Миграция с v1.0.0

При обновлении с v1.0.0 (JSON-база) на v1.1.0+ (SQLite):

```bash
node migrate.js
```

Скрипт:
1. Читает `data/db.json` (старый формат)
2. Создаёт SQLite БД
3. Переносит все данные
4. Не удаляет оригинальный файл (можно удалить вручную)

---

## Мониторинг и логи

### Логирование

Приложение выводит логи в stdout:
```
✅ SQLite: /app/data/db.sqlite
✅ Email: SMTP подключён (smtp.gmail.com)
✅ WhatsApp [baileys]: authorized
✅ Telegram: Webhook → https://club.example.kz/telegram-webhook
✅ Reminders: запущены (интервал 60с)
✅ Сервер: http://localhost:3000
```

### Docker логи

```bash
docker compose logs -f --tail 100
```

### PM2 логи

```bash
pm2 logs qr-attendance --lines 100
```

---

## Безопасность при деплое

### Чеклист

- [ ] `ADMIN_PASSWORD` — сложный пароль (12+ символов)
- [ ] `BASE_URL` — HTTPS в продакшене
- [ ] `.env` — не коммитить, добавлен в `.gitignore`
- [ ] Nginx — TLS 1.2+, HSTS
- [ ] Firewall — открыты только порты 80, 443, 22
- [ ] Обновления — `npm audit`, `apt update`
- [ ] Бэкапы — проверить наличие в `data/backups/`

### Рекомендации

1. **Не запускайте от root** — используйте Docker (встроенный `USER node`) или создайте системного пользователя
2. **Ограничьте доступ** — Nginx `allow/deny` для `/admin` при необходимости
3. **Мониторинг** — UptimeRobot или аналог на `/health`
4. **Логирование** — Настройте ротацию логов PM2 (`pm2 install pm2-logrotate`)

---

## Обновление

```bash
# Бэкап перед обновлением
cp data/db.sqlite data/backups/pre-update_$(date +%Y-%m-%d).sqlite

# Обновление кода
git pull origin main

# Обновление зависимостей
npm ci --omit=dev

# Перезапуск
pm2 restart qr-attendance
# или
docker compose up -d --build
```

Миграции БД выполняются автоматически при запуске — ручные действия не требуются.
