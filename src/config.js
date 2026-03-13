'use strict';
require('dotenv').config();

const env = process.env;

module.exports = {
  PORT:               Number(env.PORT) || 3000,
  BASE_URL:           (env.BASE_URL || 'http://localhost:3000').replace(/^["']|["']$/g, '').replace(/\/+$/, ''),
  TIMEZONE:           env.TIMEZONE || 'Asia/Almaty',
  ADMIN_PASSWORD:     env.ADMIN_PASSWORD || 'admin123',
  SCHOOL_NAME:        env.SCHOOL_NAME || 'Учебный центр',

  // WhatsApp — провайдер: greenapi (по умолчанию), twilio, wwebjs
  WA_PROVIDER:              env.WA_PROVIDER || 'greenapi',
  GREEN_API_INSTANCE_ID:    env.GREEN_API_INSTANCE_ID || '',
  GREEN_API_TOKEN:          env.GREEN_API_TOKEN || '',
  GREEN_API_URL:            env.GREEN_API_URL || 'https://api.green-api.com',
  TWILIO_ACCOUNT_SID:       env.TWILIO_ACCOUNT_SID || '',
  TWILIO_AUTH_TOKEN:        env.TWILIO_AUTH_TOKEN || '',
  TWILIO_WHATSAPP_FROM:     env.TWILIO_WHATSAPP_FROM || '',

  // Telegram
  TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN || '',

  // Email (SMTP)
  SMTP_HOST:          env.SMTP_HOST || '',
  SMTP_PORT:          env.SMTP_PORT || '465',
  SMTP_USER:          env.SMTP_USER || '',
  SMTP_PASS:          env.SMTP_PASS || '',

  // Хранение данных
  DATA_RETENTION_YEARS: Number(env.DATA_RETENTION_YEARS) || 0,
};
