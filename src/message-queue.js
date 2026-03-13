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
    this._wakeResolve = null; // для пробуждения sleep при добавлении нового сообщения
    this._counters  = { sent: 0, failed: 0 }; // in-memory счётчики
    this._ensureLog();
    this._loadCounters();
  }

  setProvider(p) {
    this.provider = p;
    this._run();
  }

  add(phone, text, label = '') {
    const job = { id: Date.now().toString(), phone, text, label, attempts: 0, nextAt: 0 };
    this.queue.push(job);
    this._log(job.id, 'queued', label);
    // Пробуждаем спящий цикл _run() если он ждёт retry delay
    if (this._wakeResolve) {
      this._wakeResolve();
      this._wakeResolve = null;
    }
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
        this._counters.sent++;
        console.log(`✅ WhatsApp → ${job.phone} (${job.label})`);
        this.queue.shift();
      } catch (err) {
        job.attempts++;
        console.error(`❌ WhatsApp попытка ${job.attempts}/${MAX_RETRIES}: ${err.message}`);
        this._log(job.id, 'retry', `попытка ${job.attempts}: ${err.message}`);

        if (job.attempts >= MAX_RETRIES) {
          this._log(job.id, 'failed', `не отправлено после ${MAX_RETRIES} попыток`);
          this._counters.failed++;
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
      const line = JSON.stringify({ id, status, note, time: new Date().toISOString() }) + '\n';
      fs.appendFileSync(LOG_PATH, line);
    } catch { /* не падать */ }
  }

  _readLog() {
    try {
      const content = fs.readFileSync(LOG_PATH, 'utf-8').trim();
      if (!content) return [];
      // Поддержка JSONL (новый формат) и JSON-массива (старый формат)
      if (content.startsWith('[')) return JSON.parse(content);
      return content.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
    catch { return []; }
  }

  _ensureLog() {
    const dir = path.dirname(LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, '');
  }

  _loadCounters() {
    const logs = this._readLog();
    this._counters.sent = logs.filter(l => l.status === 'sent').length;
    this._counters.failed = logs.filter(l => l.status === 'failed').length;
  }

  // ── Для API ───────────────────────────────────────────────────────────────────
  stats() {
    return { pending: this.queue.length, sent: this._counters.sent, failed: this._counters.failed };
  }

  log(limit = 50) {
    return this._readLog().slice(-limit).reverse();
  }

  _sleep(ms) {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      // Позволяем прервать sleep при добавлении нового сообщения
      this._wakeResolve = () => { clearTimeout(timer); resolve(); };
    });
  }
}

module.exports = new MessageQueue(); // singleton
