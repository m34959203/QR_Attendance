'use strict';
require('dotenv').config();

const env = process.env;

// Railway иногда добавляет переносы строк и кавычки в значения
const clean = (val, fallback = '') =>
  (val || fallback).replace(/^["']|["']$/g, '').trim();

module.exports = {
  PORT:               Number(env.PORT) || 3000,
  BASE_URL:           clean(env.BASE_URL, 'http://localhost:3000')
                        .replace(/^BASE_URL\s*=\s*/i, '')
                        .replace(/\/+$/, ''),
  TIMEZONE:           clean(env.TIMEZONE, 'Asia/Almaty'),
  ADMIN_PASSWORD:     clean(env.ADMIN_PASSWORD, 'admin123'),
  SCHOOL_NAME:        clean(env.SCHOOL_NAME, 'Учебный центр'),

  // WhatsApp — провайдер: baileys (по умолчанию), greenapi, twilio, wwebjs
  WA_PROVIDER:              clean(env.WA_PROVIDER, 'baileys'),
  GREEN_API_INSTANCE_ID:    clean(env.GREEN_API_INSTANCE_ID),
  GREEN_API_TOKEN:          clean(env.GREEN_API_TOKEN),
  GREEN_API_URL:            clean(env.GREEN_API_URL, 'https://api.green-api.com'),
  TWILIO_ACCOUNT_SID:       clean(env.TWILIO_ACCOUNT_SID),
  TWILIO_AUTH_TOKEN:        clean(env.TWILIO_AUTH_TOKEN),
  TWILIO_WHATSAPP_FROM:     clean(env.TWILIO_WHATSAPP_FROM),

  // Telegram
  TELEGRAM_BOT_TOKEN: clean(env.TELEGRAM_BOT_TOKEN),

  // Email (SMTP)
  SMTP_HOST:          clean(env.SMTP_HOST),
  SMTP_PORT:          clean(env.SMTP_PORT, '465'),
  SMTP_USER:          clean(env.SMTP_USER),
  SMTP_PASS:          clean(env.SMTP_PASS),

  // Хранение данных
  DATA_RETENTION_YEARS: Number(env.DATA_RETENTION_YEARS) || 0,
};
