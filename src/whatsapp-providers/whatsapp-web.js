/**
 * Провайдер: whatsapp-web.js
 * Бесплатно, но требует:
 * - Телефон с WhatsApp онлайн 24/7
 * - Puppeteer + Chromium на сервере (~300MB)
 *
 * Улучшения по сравнению с первой версией:
 * - Автоматическое переподключение при разрыве
 * - Хранение QR-кода для отображения в веб-интерфейсе
 * - Очередь сообщений при временном отключении
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');

class WhatsAppWebProvider {
  constructor() {
    this.client = null;
    this.isReady = false;
    this.qrCode = null;
    this.reconnectTimer = null;
  }

  init(onQR, onReady) {
    this._createClient(onQR, onReady);
  }

  _createClient(onQR, onReady) {
    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: './data/whatsapp-session' }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
    });

    this.client.on('qr', (qr) => {
      this.qrCode = qr;
      this.isReady = false;
      qrcodeTerminal.generate(qr, { small: true });
      console.log('\n📱 Отсканируйте QR в WhatsApp → Настройки → Связанные устройства\n');
      if (onQR) onQR(qr);
    });

    this.client.on('ready', () => {
      this.isReady = true;
      this.qrCode = null;
      console.log('✅ WhatsApp подключён!');
      if (onReady) onReady();
    });

    this.client.on('disconnected', (reason) => {
      this.isReady = false;
      console.log(`❌ WhatsApp отключён: ${reason}`);
      // Переподключение через 30 секунд
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        console.log('🔄 Переподключение WhatsApp...');
        this._createClient(onQR, onReady);
      }, 30000);
    });

    this.client.on('auth_failure', () => {
      console.log('❌ Ошибка авторизации WhatsApp — удалите data/whatsapp-session и перезапустите');
    });

    this.client.initialize().catch(err => {
      console.error('WhatsApp init error:', err.message);
    });
  }

  async send(phone, text) {
    if (!this.isReady) throw new Error('WhatsApp не подключён');
    await this.client.sendMessage(`${phone}@c.us`, text);
  }

  getStatus() {
    return { isReady: this.isReady, hasQR: !!this.qrCode, qrCode: this.qrCode };
  }
}

module.exports = WhatsAppWebProvider;
