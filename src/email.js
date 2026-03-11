/**
 * Email уведомления через nodemailer
 * Поддерживает SMTP (Gmail, Yandex, любой SMTP-провайдер)
 */
'use strict';
const config = require('./config');

let transporter = null;
let _ready = false;

function init() {
  if (!config.SMTP_HOST || !config.SMTP_USER || !config.SMTP_PASS) {
    console.log('ℹ️  Email: SMTP не настроен — уведомления по email отключены');
    return;
  }
  try {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host:   config.SMTP_HOST,
      port:   Number(config.SMTP_PORT) || 465,
      secure: Number(config.SMTP_PORT) !== 587,
      auth:   { user: config.SMTP_USER, pass: config.SMTP_PASS },
    });
    _ready = true;
    console.log(`✅ Email: SMTP подключён (${config.SMTP_HOST})`);
  } catch (e) {
    console.error('❌ Email init:', e.message);
  }
}

async function send(to, subject, html) {
  if (!_ready || !to) return;
  try {
    await transporter.sendMail({
      from: `"${config.SCHOOL_NAME}" <${config.SMTP_USER}>`,
      to, subject, html,
    });
  } catch (e) {
    console.error('❌ Email send:', e.message);
  }
}

// Готовый шаблон уведомления о приходе
async function sendArrival({ to, parentName, studentName, time, date, isLate, minutesLate, school }) {
  if (!_ready || !to) return;
  const lateHtml = isLate
    ? `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">
         <span style="color:#e53935;font-weight:700">⚠️ Опоздание: ${minutesLate} мин</span>
       </td></tr>`
    : '';
  const html = `
<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f5f7fa;padding:20px">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)">
  <div style="background:linear-gradient(135deg,#2E5FA3,#4472C4);padding:24px;text-align:center">
    <h2 style="color:#fff;margin:0;font-size:22px">🎓 ${school}</h2>
    <p style="color:rgba(255,255,255,.8);margin:6px 0 0;font-size:13px">Система учёта посещаемости</p>
  </div>
  <div style="padding:24px">
    <p style="font-size:16px;color:#333;margin-bottom:16px">Здравствуйте, <b>${parentName}</b>!</p>
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:13px">Ученик</td>
          <td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:700;text-align:right">${studentName}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:13px">Время прихода</td>
          <td style="padding:8px 0;border-bottom:1px solid #eee;font-weight:700;text-align:right;color:#2E5FA3">${time}</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#888;font-size:13px">Дата</td>
          <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">${date}</td></tr>
      ${lateHtml}
    </table>
    <div style="margin-top:20px;padding:14px;background:#e8f5e9;border-radius:10px;font-size:14px;color:#2e7d32">
      ${isLate ? '⚠️ Ученик опоздал' : '✅ Ученик пришёл вовремя'}
    </div>
  </div>
  <div style="padding:14px 24px;background:#f7f9fc;text-align:center;font-size:11px;color:#aaa">
    Вы получаете это письмо т.к. являетесь родителем ученика ${school}.
    Для отписки обратитесь к учителю.
  </div>
</div>
</body></html>`;
  await send(to, `[${school}] ${studentName} пришёл(а) в ${time}`, html);
}

async function sendTest(to, school) {
  await send(to, `[${school}] Тестовое письмо`,
    `<p>✅ Email-уведомления настроены корректно.</p><p>Школа: <b>${school}</b></p>`);
}

function getStatus() {
  return { ready: _ready, host: config.SMTP_HOST || null, user: config.SMTP_USER || null };
}

module.exports = { init, send, sendArrival, sendTest, getStatus };
