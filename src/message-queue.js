/**
 * Очередь сообщений WhatsApp
 *
 * Если Green API временно недоступен — сообщение не теряется.
 * Повторные попытки: 30 сек → 2 мин → 5 мин → сдаёмся, пишем в лог.
 * Лог хранится в data/message-log.json (последние 500 записей).
 */
const fs   = require('fs');
const path = require('path');

const LOG_PATH    = path.join(__dirname, '../data/message-log.json');
const MAX_RETRIES = 3;
const DELAYS      = [30_000, 120_000, 300_000]; // 30с → 2мин → 5мин

class MessageQueue {
  constructor() {
    this.queue      = [];   // [{phone, text, label, attempts, nextAt}]
    this.provider   = null;
    this.running    = false;
    this._ensureLog();
  }

  setProvider(p) {
    this.provider = p;
    // Если в очереди что-то есть — обрабатываем
    this._run();
  }

  // Добавить сообщение в очередь (вызывается из server.js)
  add(phone, text, label = '') {
    const job = { id: Date.now().toString(), phone, text, label, attempts: 0, nextAt: 0 };
    this.queue.push(job);
    this._log(job.id, 'queued', label);
    this._run();
  }

  // ── Обработка ────────────────────────────────────────────────────────────────
  async _run() {
    if (this.running || !this.provider || !this.queue.length) return;
    this.running = true;

    while (this.queue.length) {
      const job = this.queue[0];

      // Ещё не время для повторной попытки
      if (job.nextAt > Date.now()) {
        await this._sleep(Math.min(job.nextAt - Date.now(), 5000));
        continue;
      }

      try {
        await this.provider.sendMessage(job.phone, job.text);
        this._log(job.id, 'sent', job.label);
        console.log(`✅ WhatsApp → ${job.phone} (${job.label})`);
        this.queue.shift();
      } catch (err) {
        job.attempts++;
        console.error(`❌ WhatsApp попытка ${job.attempts}/${MAX_RETRIES}: ${err.message}`);
        this._log(job.id, 'retry', `попытка ${job.attempts}: ${err.message}`);

        if (job.attempts >= MAX_RETRIES) {
          this._log(job.id, 'failed', `не отправлено после ${MAX_RETRIES} попыток`);
          console.error(`💀 Сообщение для ${job.label} не отправлено`);
          this.queue.shift();
        } else {
          const delay = DELAYS[job.attempts - 1];
          job.nextAt  = Date.now() + delay;
          console.log(`🔄 Повтор через ${delay / 1000}с...`);
          await this._sleep(delay);
        }
      }
    }

    this.running = false;
  }

  // ── Лог ──────────────────────────────────────────────────────────────────────
  _log(id, status, note) {
    try {
      const logs = this._readLog();
      logs.push({ id, status, note, time: new Date().toISOString() });
      fs.writeFileSync(LOG_PATH, JSON.stringify(logs.slice(-500), null, 2));
    } catch { /* не падать */ }
  }

  _readLog() {
    try { return JSON.parse(fs.readFileSync(LOG_PATH, 'utf-8')); }
    catch { return []; }
  }

  _ensureLog() {
    const dir = path.dirname(LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, '[]');
  }

  // ── Для API ───────────────────────────────────────────────────────────────────
  stats() {
    const logs   = this._readLog();
    const sent   = logs.filter(l => l.status === 'sent').length;
    const failed = logs.filter(l => l.status === 'failed').length;
    return { pending: this.queue.length, sent, failed };
  }

  log(limit = 50) {
    return this._readLog().slice(-limit).reverse();
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = new MessageQueue(); // singleton
