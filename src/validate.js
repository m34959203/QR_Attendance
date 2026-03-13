/**
 * Валидация входных данных API — без внешних зависимостей.
 * Используется в server.js для всех POST/PUT эндпоинтов.
 */
'use strict';

const PHONE_RE = /^\d{10,15}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TIME_RE  = /^\d{2}:\d{2}$/;

function validateStudent(body) {
  const errors = [];
  if (!body.name || !body.name.trim()) {
    errors.push('Укажите имя ученика');
  } else if (body.name.trim().length > 100) {
    errors.push('Имя ученика слишком длинное (макс. 100 символов)');
  }

  if (body.parentPhone) {
    const phone = String(body.parentPhone).replace(/\D/g, '');
    if (!PHONE_RE.test(phone)) {
      errors.push('Неверный формат номера телефона (10–15 цифр)');
    }
  }

  if (body.parentEmail) {
    const email = String(body.parentEmail).trim();
    if (email && !EMAIL_RE.test(email)) {
      errors.push('Неверный формат email');
    }
  }

  if (body.parentName && String(body.parentName).length > 100) {
    errors.push('Имя родителя слишком длинное (макс. 100 символов)');
  }

  if (body.telegramChatId) {
    const chatId = String(body.telegramChatId).trim();
    if (chatId && !/^-?\d{1,20}$/.test(chatId)) {
      errors.push('Telegram chat_id должен быть числом');
    }
  }

  return errors.length ? errors : null;
}

function validateGroup(body) {
  const errors = [];
  if (!body.name || !body.name.trim()) {
    errors.push('Укажите название группы');
  } else if (body.name.trim().length > 100) {
    errors.push('Название группы слишком длинное (макс. 100 символов)');
  }

  if (body.lessonStartTime && !TIME_RE.test(body.lessonStartTime)) {
    errors.push('Время начала занятия — формат ЧЧ:ММ');
  }

  if (body.lateMinutes !== undefined) {
    const n = Number(body.lateMinutes);
    if (isNaN(n) || n < 0 || n > 120) {
      errors.push('Порог опоздания: 0–120 минут');
    }
  }

  return errors.length ? errors : null;
}

function validatePhone(phone) {
  if (!phone) return 'Укажите номер телефона';
  const clean = String(phone).replace(/\D/g, '');
  if (!PHONE_RE.test(clean)) return 'Неверный формат номера (10–15 цифр)';
  return null;
}

function validateMessage(message) {
  if (!message || !message.trim()) return 'Укажите сообщение';
  if (message.length > 4096) return 'Сообщение слишком длинное (макс. 4096 символов)';
  return null;
}

module.exports = { validateStudent, validateGroup, validatePhone, validateMessage };
