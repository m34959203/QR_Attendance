/**
 * Green API — отправка сообщений в WhatsApp через HTTP
 * Документация: https://green-api.com/docs/api/sending/SendMessage/
 */
const https = require('https');

class GreenAPI {
  constructor({ instanceId, instanceToken }) {
    if (!instanceId || instanceId === 'ВСТАВЬТЕ_ID_ИНСТАНСА') {
      throw new Error('Укажите GREEN_API_INSTANCE_ID в src/config.js');
    }
    if (!instanceToken || instanceToken === 'ВСТАВЬТЕ_ТОКЕН') {
      throw new Error('Укажите GREEN_API_TOKEN в src/config.js');
    }
    this.instanceId    = instanceId;
    this.instanceToken = instanceToken;
  }

  // Отправить сообщение
  async sendMessage(phone, text) {
    const body = JSON.stringify({ chatId: `${phone}@c.us`, message: text });
    const res  = await this._post(`/sendMessage/${this.instanceToken}`, body);
    if (!res.idMessage) throw new Error(`Green API: неожиданный ответ: ${JSON.stringify(res)}`);
    return res;
  }

  // Проверить статус инстанса (authorized / notAuthorized / ...)
  async getStateInstance() {
    return this._get(`/getStateInstance/${this.instanceToken}`);
  }

  // ── Внутренние HTTP-хелперы ─────────────────────────────────────────────────
  _post(apiPath, body) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.green-api.com',
        path:     `/waInstance${this.instanceId}${apiPath}`,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 15000,
      }, res => this._readJSON(res, resolve, reject));
      req.on('timeout', () => { req.destroy(); reject(new Error('Green API: таймаут запроса')); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  _get(apiPath) {
    return new Promise((resolve, reject) => {
      const req = https.get({
        hostname: 'api.green-api.com',
        path:     `/waInstance${this.instanceId}${apiPath}`,
        timeout: 15000,
      }, res => this._readJSON(res, resolve, reject));
      req.on('timeout', () => { req.destroy(); reject(new Error('Green API: таймаут запроса')); });
      req.on('error', reject);
    });
  }

  _readJSON(res, resolve, reject) {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (res.statusCode >= 400) reject(new Error(`Green API HTTP ${res.statusCode}: ${data}`));
        else resolve(parsed);
      } catch (e) {
        reject(new Error(`Green API: не JSON: ${data}`));
      }
    });
  }
}

module.exports = GreenAPI;
