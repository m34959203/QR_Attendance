/**
 * WhatsApp модуль — мультипровайдерный фасад
 *
 * Выбирает провайдера из config.WA_PROVIDER (greenapi | twilio | wwebjs)
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
  providerName = config.WA_PROVIDER || 'greenapi';
  console.log(`\n📱 WhatsApp провайдер: ${providerName}`);

  try {
    switch (providerName) {
      case 'greenapi': await _initGreenAPI(); break;
      case 'twilio':   _initTwilio();         break;
      case 'wwebjs':   _initWWebJS();         break;
      default:
        throw new Error(`Неизвестный провайдер: ${providerName}. Доступны: greenapi, twilio, wwebjs`);
    }
  } catch (err) {
    state = 'error';
    console.error(`❌ WhatsApp (${providerName}): ${err.message}`);
  }
}

// ── Инициализаторы провайдеров ─────────────────────────────────────────────────

async function _initGreenAPI() {
  const GreenAPI = require('./whatsapp-providers/green-api');
  client = new GreenAPI({
    instanceId:    config.GREEN_API_INSTANCE_ID,
    instanceToken: config.GREEN_API_TOKEN,
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

module.exports = { init, send, sendDirect, getStatus, getLog };
