/**
 * WhatsApp модуль
 * Выбирает провайдера из config.js и оборачивает в единый интерфейс.
 * Все сообщения идут через очередь с повторными попытками.
 *
 * Использование в server.js:
 *   const wa = require('./whatsapp');
 *   wa.init();
 *   await wa.send(phone, text, studentName);
 *   wa.getStatus();
 */

const config = require('../config');
const queue  = require('../message-queue');

let provider = null;
let providerName = '';

function init() {
  providerName = config.WA_PROVIDER || 'greenapi';
  console.log(`\n📱 WhatsApp провайдер: ${providerName}`);

  try {
    switch (providerName) {
      case 'greenapi':
        provider = initGreenAPI();
        break;
      case 'twilio':
        provider = initTwilio();
        break;
      case 'wwebjs':
        provider = initWWebJS();
        break;
      default:
        throw new Error(`Неизвестный провайдер: ${providerName}. Доступны: greenapi, twilio, wwebjs`);
    }
  } catch (err) {
    console.error(`❌ Ошибка инициализации WhatsApp (${providerName}): ${err.message}`);
    console.error('   Проверьте настройки в src/config.js\n');
    provider = null;
  }

  queue.setProvider(provider);
}

// ── Инициализаторы провайдеров ────────────────────────────────────────────────

function initGreenAPI() {
  const GreenAPI = require('../whatsapp-providers/green-api');
  const p = new GreenAPI({
    instanceId:    config.GREENAPI_ID_INSTANCE,
    instanceToken: config.GREENAPI_API_TOKEN,
  });

  // Проверяем статус инстанса при старте
  p.getStatus()
    .then(s => {
      if (s.stateInstance === 'authorized') {
        console.log('✅ Green API: авторизован');
      } else {
        console.log(`⚠️  Green API: статус "${s.stateInstance}"`);
        console.log('   Зайдите в личный кабинет green-api.com и подключите WhatsApp к инстансу');
      }
    })
    .catch(err => {
      console.error('❌ Green API: не удалось проверить статус —', err.message);
      console.error('   Проверьте GREENAPI_ID_INSTANCE и GREENAPI_API_TOKEN в config.js');
    });

  return p;
}

function initTwilio() {
  const Twilio = require('../whatsapp-providers/twilio');
  const p = new Twilio({
    accountSid: config.TWILIO_ACCOUNT_SID,
    authToken:  config.TWILIO_AUTH_TOKEN,
    fromPhone:  config.TWILIO_WHATSAPP_FROM,
  });
  console.log('✅ Twilio: готов к отправке');
  return p;
}

function initWWebJS() {
  const WWebJS = require('../whatsapp-providers/whatsapp-web');
  const p = new WWebJS();
  p.init(
    () => console.log('📱 WWebJS: QR готов — откройте WhatsApp → Связанные устройства'),
    () => console.log('✅ WWebJS: подключён!')
  );
  return p;
}

// ── Публичный интерфейс ───────────────────────────────────────────────────────

/**
 * Отправить сообщение через очередь (не теряется при сбоях)
 * @param {string} phone       - номер без +, только цифры: 77001234567
 * @param {string} text        - текст сообщения
 * @param {string} studentName - для логов
 */
function send(phone, text, studentName = '') {
  if (!provider) {
    console.error('WhatsApp: провайдер не инициализирован — сообщение не отправлено');
    return null;
  }
  return queue.enqueue(phone, text, studentName);
}

/**
 * Статус для API /api/whatsapp/status
 */
function getStatus() {
  const stats = queue.getStats();

  const base = {
    provider: providerName,
    configured: !!provider,
    queueLength: stats.queueLength,
    stats: { sent: stats.sent, failed: stats.failed },
  };

  // wwebjs имеет динамический статус (isReady, QR-код)
  if (provider && providerName === 'wwebjs' && typeof provider.getStatus === 'function') {
    return { ...base, ...provider.getStatus() };
  }

  return { ...base, isReady: !!provider };
}

/**
 * Лог сообщений для /api/whatsapp/log
 */
function getLog(limit = 50) {
  return queue.getLog(limit);
}

module.exports = { init, send, getStatus, getLog };
