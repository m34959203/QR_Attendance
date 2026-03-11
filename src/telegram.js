/**
 * Telegram модуль — Webhook режим
 *
 * При наличии BASE_URL (не localhost) — регистрирует Webhook у Telegram.
 * Telegram сам шлёт обновления на POST /telegram-webhook.
 * Fallback: если BASE_URL = localhost, автоматически переключается на Long Polling.
 *
 * Команды бота:
 *   /start → бот отвечает с chat_id родителя
 *   /id    → для отладки
 */

const https  = require('https');
const config = require('./config');

let _polling = false;
let _lastId  = 0;
let _ready   = false;
let _botName = '';

// ── Инициализация ─────────────────────────────────────────────────────────────
async function init() {
  if (!config.TELEGRAM_BOT_TOKEN) {
    console.log('ℹ️  Telegram: токен не указан, уведомления отключены');
    return null;
  }

  // Проверяем бота
  try {
    const me = await _get('getMe');
    _botName = me.result.username;
    console.log(`📨 Telegram бот: @${_botName}`);
  } catch (e) {
    console.error('❌ Telegram: не удалось проверить токен —', e.message);
    return null;
  }

  const isLocalhost = config.BASE_URL.includes('localhost') || config.BASE_URL.includes('127.0.0.1');

  if (!isLocalhost) {
    // WEBHOOK режим
    const hookUrl = `${config.BASE_URL}/telegram-webhook`;
    try {
      await _post('setWebhook', { url: hookUrl });
      _ready = true;
      console.log(`✅ Telegram Webhook установлен: ${hookUrl}`);
    } catch (e) {
      console.error('❌ Telegram Webhook ошибка:', e.message);
      console.log('   Переключаюсь на Long Polling...');
      await _startPolling();
    }
  } else {
    // LONG POLLING режим (только localhost/разработка)
    await _post('deleteWebhook', {});
    await _startPolling();
  }

  return _botName;
}

// Обработчик входящего update от Webhook (вызывается из server.js)
async function handleWebhookUpdate(update) {
  await _handleUpdate(update);
}

// ── Long Polling (fallback) ───────────────────────────────────────────────────
async function _startPolling() {
  _polling = true;
  _ready   = true;
  console.log('📨 Telegram: Long Polling запущен (режим разработки)');
  _poll();
}

async function _poll() {
  if (!_polling) return;
  try {
    const data = await _get('getUpdates', { offset: _lastId + 1, timeout: 25 });
    for (const u of data.result || []) {
      _lastId = u.update_id;
      await _handleUpdate(u);
    }
  } catch (e) {
    if (_polling) await _sleep(5000);
  }
  if (_polling) _poll();
}

// ── Обработка входящего сообщения ─────────────────────────────────────────────
async function _handleUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId   = msg.chat.id;
  const text     = msg.text.trim();
  const fromName = msg.from.first_name || 'Родитель';

  if (text.startsWith('/start')) {
    await sendMessage(chatId,
      `👋 Здравствуйте, ${fromName}!\n\n` +
      `Это бот уведомлений об уроках.\n\n` +
      `Ваш <b>код подключения</b> (chat_id):\n\n` +
      `<code>${chatId}</code>\n\n` +
      `Передайте этот код учителю — он введёт его в карточку ученика.`
    );
    return;
  }

  if (text === '/id') {
    await sendMessage(chatId, `Ваш chat_id: <code>${chatId}</code>`);
    return;
  }

  if (text === '/stop') {
    // Ищем ученика с этим chat_id и ставим telegramStopAt
    const db = require('./db');
    const students = db.getStudents(null, true).filter(s => String(s.telegramChatId) === String(chatId));
    if (students.length) {
      for (const s of students) {
        db.updateStudent(s.id, { telegramStopAt: new Date().toISOString() });
      }
      await sendMessage(chatId,
        `🚫 Вы отписались от уведомлений.\n\nЧтобы снова получать уведомления, напишите /start и передайте код учителю.`);
    } else {
      await sendMessage(chatId, `ℹ️ Ваш аккаунт не привязан ни к одному ученику. Обратитесь к учителю.`);
    }
    return;
  }

  if (text === '/help') {
    await sendMessage(chatId,
      `ℹ️ <b>Помощь</b>\n\n` +
      `/start — получить ваш код подключения\n` +
      `/stop — отписаться от уведомлений\n` +
      `/help — эта справка`);
    return;
  }
}

// ── Публичный API ─────────────────────────────────────────────────────────────
async function sendMessage(chatId, text) {
  if (!config.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN не задан');
  return _post('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
}

async function getStatus() {
  if (!config.TELEGRAM_BOT_TOKEN) return { enabled: false, reason: 'токен не задан' };
  try {
    const me   = await _get('getMe');
    const info = await _get('getWebhookInfo');
    const isWebhook = !!info.result.url;
    return {
      enabled:    true,
      ready:      _ready,
      mode:       isWebhook ? 'webhook' : 'polling',
      webhookUrl: info.result.url || null,
      botName:    me.result.username,
      botId:      me.result.id,
    };
  } catch (e) {
    return { enabled: false, reason: e.message };
  }
}

// ── HTTP хелперы ──────────────────────────────────────────────────────────────
function _post(method, body) {
  const json = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${config.TELEGRAM_BOT_TOKEN}/${method}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) },
    }, res => _read(res, resolve, reject));
    req.on('error', reject);
    req.write(json);
    req.end();
  });
}

function _get(method, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'api.telegram.org',
      path: `/bot${config.TELEGRAM_BOT_TOKEN}/${method}${qs ? '?' + qs : ''}`,
    }, res => _read(res, resolve, reject)).on('error', reject);
  });
}

function _read(res, resolve, reject) {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    try {
      const p = JSON.parse(d);
      if (!p.ok) reject(new Error(`Telegram: ${p.description}`));
      else resolve(p);
    } catch { reject(new Error(`Telegram: не JSON`)); }
  });
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { init, sendMessage, getStatus, handleWebhookUpdate };
