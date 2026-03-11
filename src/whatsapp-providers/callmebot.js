/**
 * Провайдер: CallMeBot
 * Сайт: https://callmebot.com/blog/free-api-whatsapp-messages/
 * Цена: БЕСПЛАТНО
 *
 * Ограничение: каждая мама должна сама активировать бота один раз:
 * 1. Добавить в контакты: +34 644 52 74 65
 * 2. Написать ему: "I allow callmebot to send me messages"
 * 3. Получить apikey в ответ
 * 4. Учитель вводит этот apikey при добавлении ученика
 *
 * Подходит для теста или если мамы готовы сделать этот шаг.
 */

const https = require('https');

class CallMeBotProvider {
  constructor() {}

  async send(phone, text, apiKey) {
    if (!apiKey) {
      throw new Error('CallMeBot: нужен apiKey родителя');
    }

    const params = new URLSearchParams({
      phone: `+${phone}`,
      text,
      apikey: apiKey,
    });

    return new Promise((resolve, reject) => {
      https.get(
        `https://api.callmebot.com/whatsapp.php?${params.toString()}`,
        (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode === 200) resolve({ ok: true });
            else reject(new Error(`CallMeBot вернул ${res.statusCode}`));
          });
        }
      ).on('error', reject);
    });
  }
}

module.exports = CallMeBotProvider;
