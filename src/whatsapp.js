/**
 * WhatsApp модуль — мультипровайдерный фасад
 *
 * Выбирает провайдера из config.WA_PROVIDER (baileys | greenapi | twilio | wwebjs)
 * и оборачивает в единый интерфейс. Все сообщения идут через message-queue
 * с повторными попытками (30с → 2мин → 5мин).
 *
 * Провайдер должен реализовать метод sendMessage(phone, text).
 */
'use strict';
const config = require('./config');
const queue  = require('./message-queue');

let client       = null;
let providerName = '';
let state        = 'init'; // init | authorized | notAuthorized | error

async function init() {
  providerName = config.WA_PROVIDER || 'baileys';
  console.log(`\n📱 WhatsApp провайдер: ${providerName}`);

  try {
    switch (providerName) {
      case 'baileys':  await _initBaileys();  break;
      case 'greenapi': await _initGreenAPI(); break;
      case 'twilio':   _initTwilio();         break;
      case 'wwebjs':   _initWWebJS();         break;
      default:
        throw new Error(`Неизвестный провайдер: ${providerName}. Доступны: baileys, greenapi, twilio, wwebjs`);
    }
  } catch (err) {
    state = 'error';
    console.error(`❌ WhatsApp (${providerName}): ${err.message}`);
  }
}

// ── Инициализаторы провайдеров ─────────────────────────────────────────────────

async function _initBaileys() {
  const BaileysProvider = require('./whatsapp-providers/baileys');
  const baileys = new BaileysProvider();
  await baileys.init();

  client = baileys;
  const res = await baileys.getStateInstance();
  state = res.stateInstance;

  if (state === 'authorized') {
    queue.setProvider(client);
    console.log('✅ Baileys: WhatsApp подключён');
  } else {
    console.warn('⚠️  Baileys: нужна авторизация через QR-код');
    console.warn('   Откройте админ-панель → вкладка WhatsApp → сканируйте QR\n');
    // Ждём авторизации и автоматически активируем очередь
    _watchBaileysAuth(baileys);
  }
}

function _watchBaileysAuth(baileys) {
  const check = setInterval(() => {
    const s = baileys.getStatus();
    if (s.baileysState === 'authorized' && state !== 'authorized') {
      state = 'authorized';
      queue.setProvider(client);
      console.log('✅ Baileys: WhatsApp авторизован, очередь активирована');
      clearInterval(check);
    }
  }, 2000);
  // Не блокируем процесс
  check.unref?.();
}

async function _initGreenAPI() {
  const GreenAPI = require('./whatsapp-providers/green-api');
  client = new GreenAPI({
    instanceId:    config.GREEN_API_INSTANCE_ID,
    instanceToken: config.GREEN_API_TOKEN,
    apiUrl:        config.GREEN_API_URL,
  });

  const res = await client.getStateInstance();
  state = res.stateInstance;

  if (state === 'authorized') {
    queue.setProvider(client);
    console.log('✅ Green API: WhatsApp подключён');
  } else {
    console.warn(`⚠️  Green API: статус "${state}"`);
    console.warn('   Зайдите на green-api.com → инстанс → «Сканировать QR»\n');
  }
}

function _initTwilio() {
  const Twilio = require('./whatsapp-providers/twilio');
  const raw = new Twilio({
    accountSid: config.TWILIO_ACCOUNT_SID,
    authToken:  config.TWILIO_AUTH_TOKEN,
    fromPhone:  config.TWILIO_WHATSAPP_FROM,
  });
  // Адаптер: очередь вызывает sendMessage(), Twilio имеет send()
  client = { sendMessage: (phone, text) => raw.send(phone, text) };
  state = 'authorized';
  queue.setProvider(client);
  console.log('✅ Twilio: готов к отправке');
}

function _initWWebJS() {
  const WWebJS = require('./whatsapp-providers/whatsapp-web');
  const raw = new WWebJS();
  // Адаптер: очередь вызывает sendMessage(), WWebJS имеет send()
  client = {
    sendMessage: (phone, text) => raw.send(phone, text),
    getStatus:   () => raw.getStatus(),
  };
  raw.init(
    () => { state = 'notAuthorized'; console.log('📱 WWebJS: QR готов'); },
    () => { state = 'authorized'; queue.setProvider(client); console.log('✅ WWebJS: подключён!'); },
  );
}

// ── Публичный интерфейс ────────────────────────────────────────────────────────

function send(phone, text, label = '') {
  if (!client) {
    console.error('WhatsApp не инициализирован — сообщение пропущено');
    return;
  }
  queue.add(phone, text, label);
}

async function sendDirect(phone, text) {
  if (!client) throw new Error('WhatsApp не инициализирован. Проверьте настройки провайдера.');
  return client.sendMessage(phone, text);
}

function getStatus() {
  const base = {
    provider: providerName,
    state,
    isReady: state === 'authorized',
    ...queue.stats(),
  };
  if (client && typeof client.getStatus === 'function') {
    return { ...base, ...client.getStatus() };
  }
  return base;
}

function getLog(limit) {
  return queue.log(limit);
}

/** Получить QR для Baileys (или null для других провайдеров) */
function getQR() {
  if (client && typeof client.getQR === 'function') {
    return client.getQR();
  }
  return null;
}

/** Выйти из WhatsApp (только Baileys) */
async function logout() {
  if (client && typeof client.logout === 'function') {
    await client.logout();
    state = 'notAuthorized';
  }
}

/** Переподключить (только Baileys) */
async function restart() {
  if (client && typeof client.restart === 'function') {
    await client.restart();
    state = 'init';
    _watchBaileysAuth(client);
  }
}

module.exports = { init, send, sendDirect, getStatus, getLog, getQR, logout, restart };
