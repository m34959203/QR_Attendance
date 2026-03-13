/**
 * Baileys — прямое подключение к WhatsApp через WebSocket
 * Бесплатная альтернатива Green API. Авторизация через QR-код в админке.
 *
 * Интерфейс:
 *   - sendMessage(phone, text)   → отправить сообщение
 *   - getStateInstance()          → { stateInstance: 'authorized' | 'notAuthorized' | ... }
 *   - getQR()                    → base64 QR для авторизации или null
 *   - logout()                   → выйти из WA
 *   - restart()                  → переподключиться
 *   - getStatus()                → доп. информация (phoneNumber и т.д.)
 */
'use strict';

const path = require('path');
const fs   = require('fs');

const SESSION_DIR = path.join(__dirname, '../../data/baileys-session');

class BaileysProvider {
  constructor() {
    this._sock       = null;
    this._state      = 'init';     // init | qr | authorized | disconnected | error
    this._qrBase64   = null;       // data:image/png;base64,... для UI
    this._qrString   = null;       // raw QR string
    this._phone      = null;
    this._retryCount = 0;
    this._destroyed  = false;
    this._connecting = false;
  }

  // ── Инициализация ───────────────────────────────────────────────

  async init() {
    // Динамический импорт ESM-модулей
    if (!this._baileys) {
      this._baileys = await import('@whiskeysockets/baileys');
      this._qrcode  = require('qrcode');
    }
    await this._connect();
    return this;
  }

  async _connect() {
    if (this._connecting) return;
    this._connecting = true;

    try {
      const {
        default: makeWASocket,
        useMultiFileAuthState,
        DisconnectReason,
        fetchLatestBaileysVersion,
        makeCacheableSignalKeyStore,
      } = this._baileys;

      // Создаём папку сессии
      if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this._logger()),
        },
        printQRInTerminal: false,
        generateHighQualityLinkPreview: false,
        // Тишина в логах
        logger: this._logger(),
      });

      this._sock = sock;

      // ── Обработчики событий ─────────────────────────

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this._qrString = qr;
          this._qrBase64 = await this._qrcode.toDataURL(qr, { width: 300, margin: 2 });
          this._state = 'qr';
          console.log('📱 Baileys: QR-код готов для сканирования');
        }

        if (connection === 'open') {
          this._state      = 'authorized';
          this._qrBase64   = null;
          this._qrString   = null;
          this._retryCount = 0;
          this._phone      = sock.user?.id?.split(':')[0] || null;
          console.log(`✅ Baileys: WhatsApp подключён (${this._phone || 'N/A'})`);
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const reason = lastDisconnect?.error?.output?.payload?.message || 'unknown';

          console.log(`⚠️  Baileys: соединение закрыто (${statusCode}: ${reason})`);

          // 401 = logged out → очищаем сессию
          if (statusCode === DisconnectReason.loggedOut) {
            this._state = 'notAuthorized';
            this._clearSession();
            console.log('📱 Baileys: сессия сброшена, нужна повторная авторизация');
          }
          // 408/503 = network → реконнект
          else if (!this._destroyed && this._retryCount < 10) {
            this._retryCount++;
            const delay = Math.min(2000 * this._retryCount, 30000);
            console.log(`🔄 Baileys: реконнект через ${delay / 1000}с (попытка ${this._retryCount})...`);
            this._state = 'disconnected';
            this._connecting = false;
            setTimeout(() => this._connect(), delay);
            return;
          } else {
            this._state = 'error';
          }
        }
      });

    } catch (err) {
      this._state = 'error';
      console.error('❌ Baileys ошибка подключения:', err.message);
    } finally {
      this._connecting = false;
    }
  }

  // ── Публичные методы ────────────────────────────────────────────

  async sendMessage(phone, text) {
    if (!this._sock || this._state !== 'authorized') {
      throw new Error('WhatsApp (Baileys) не подключён');
    }
    const jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
    const result = await this._sock.sendMessage(jid, { text });
    return { idMessage: result.key.id };
  }

  async getStateInstance() {
    // Маппинг на формат, совместимый с Green API
    const map = {
      authorized:    'authorized',
      qr:            'notAuthorized',
      init:          'notAuthorized',
      disconnected:  'notAuthorized',
      notAuthorized: 'notAuthorized',
      error:         'error',
    };
    return { stateInstance: map[this._state] || 'notAuthorized' };
  }

  getQR() {
    return this._state === 'qr' ? this._qrBase64 : null;
  }

  getStatus() {
    return {
      baileysState: this._state,
      phoneNumber:  this._phone,
      hasQR:        this._state === 'qr',
    };
  }

  async logout() {
    if (this._sock) {
      try { await this._sock.logout(); } catch {}
    }
    this._clearSession();
    this._state = 'notAuthorized';
    this._qrBase64 = null;
    this._phone = null;
    console.log('📱 Baileys: выход из WhatsApp');
  }

  async restart() {
    this._destroyed = true;
    if (this._sock) {
      try { this._sock.end(); } catch {}
    }
    this._sock = null;
    this._state = 'init';
    this._qrBase64 = null;
    this._retryCount = 0;
    this._destroyed = false;
    console.log('🔄 Baileys: перезапуск...');
    await this._connect();
  }

  // ── Внутренние ──────────────────────────────────────────────────

  _clearSession() {
    try {
      if (fs.existsSync(SESSION_DIR)) {
        fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      }
    } catch (e) {
      console.error('Не удалось очистить сессию Baileys:', e.message);
    }
  }

  _logger() {
    // Минимальный логгер pino-совместимый (Baileys требует)
    const noop = () => {};
    return {
      level: 'silent',
      info: noop, debug: noop, warn: noop, error: noop, trace: noop, fatal: noop,
      child: () => this._logger(),
    };
  }
}

module.exports = BaileysProvider;
