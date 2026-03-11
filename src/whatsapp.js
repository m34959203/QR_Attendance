/**
 * WhatsApp модуль (Green API)
 * Инициализирует провайдера, проверяет авторизацию, управляет очередью.
 */
const config = require('./config');
const queue  = require('./message-queue');
const GreenAPI = require('./whatsapp-providers/green-api');

let client = null;
let state  = 'init'; // init | ok | error | not-authorized

async function init() {
  try {
    client = new GreenAPI({
      instanceId:    config.GREEN_API_INSTANCE_ID,
      instanceToken: config.GREEN_API_TOKEN,
    });

    const res = await client.getStateInstance();
    state = res.stateInstance; // 'authorized' | 'notAuthorized' | ...

    if (state === 'authorized') {
      queue.setProvider(client);
      console.log('✅ Green API: WhatsApp подключён, сообщения будут отправляться');
    } else {
      console.warn(`⚠️  Green API: статус "${state}"`);
      console.warn('   Зайдите на green-api.com → инстанс → "Сканировать QR"');
      console.warn('   и подключите ваш WhatsApp\n');
    }
  } catch (err) {
    state = 'error';
    console.error('❌ Green API ошибка:', err.message);
    if (err.message.includes('INSTANCE_ID') || err.message.includes('TOKEN')) {
      console.error('   Заполните GREEN_API_INSTANCE_ID и GREEN_API_TOKEN в src/config.js\n');
    }
  }
}

// Добавить сообщение в очередь (не ждём — ответ ученику не задерживается)
function send(phone, text, label = '') {
  if (!client) {
    console.error('WhatsApp не инициализирован — сообщение пропущено');
    return;
  }
  queue.add(phone, text, label);
}

function getStatus() {
  return {
    provider:  'green-api',
    state,                          // 'authorized' | 'notAuthorized' | 'error' | 'init'
    isReady:   state === 'authorized',
    ...queue.stats(),
  };
}

function getLog(limit) {
  return queue.log(limit);
}

module.exports = { init, send, getStatus, getLog };

// Прямая отправка (для тестовых сообщений) — без очереди
async function sendDirect(phone, text) {
  if (!client) throw new Error('WhatsApp не инициализирован. Проверьте GREEN_API_INSTANCE_ID и GREEN_API_TOKEN');
  return client.sendMessage(phone, text);
}

module.exports.sendDirect = sendDirect;
