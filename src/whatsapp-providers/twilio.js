/**
 * Провайдер: Twilio WhatsApp
 * Сайт: https://twilio.com
 * Цена: ~$0.005 за сообщение (очень дёшево)
 * Самый надёжный вариант, не забанит никогда
 *
 * Настройка:
 * 1. Зарегистрироваться на twilio.com
 * 2. Перейти в Console → Messaging → Try WhatsApp
 * 3. Получить ACCOUNT_SID, AUTH_TOKEN, TWILIO_PHONE (формат: whatsapp:+14155238886)
 */

const https = require('https');

class TwilioProvider {
  constructor({ accountSid, authToken, fromPhone }) {
    if (!accountSid || !authToken || !fromPhone) {
      throw new Error('TWILIO: нужны accountSid, authToken, fromPhone (src/config.js)');
    }
    this.accountSid = accountSid;
    this.authToken = authToken;
    this.fromPhone = fromPhone; // whatsapp:+14155238886
  }

  async send(phone, text) {
    const body = new URLSearchParams({
      From: this.fromPhone,
      To: `whatsapp:+${phone}`,
      Body: text,
    }).toString();

    return new Promise((resolve, reject) => {
      const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

      const req = https.request({
        hostname: 'api.twilio.com',
        path: `/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const parsed = JSON.parse(data);
          if (res.statusCode === 201) {
            resolve(parsed);
          } else {
            reject(new Error(`Twilio ошибка ${res.statusCode}: ${parsed.message}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

module.exports = TwilioProvider;
