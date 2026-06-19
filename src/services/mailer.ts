// Sadə email göndərmə servisi (SMTP).
// Railway → Variables-da bunlar qoyulanda real email gedir:
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM (ixtiyari)
// Qoyulmasa email göndərilmir (dev rejimi — kod cavabda qaytarılır).

import nodemailer, { Transporter } from 'nodemailer';

let transporter: Transporter | null = null;
let initialized = false;

function getTransporter(): Transporter | null {
  if (initialized) return transporter;
  initialized = true;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  const port = parseInt(SMTP_PORT || '587');
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465, // 465 = SSL, 587 = STARTTLS
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

export function isMailerConfigured(): boolean {
  return getTransporter() !== null;
}

/** Email göndərir. SMTP qoyulmayıbsa false qaytarır (göndərilmir). */
export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const tr = getTransporter();
  if (!tr) return false;
  try {
    await tr.sendMail({
      from: process.env.SMTP_FROM || `tradixai <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
    });
    return true;
  } catch (e) {
    console.error('[mailer] send error:', e);
    return false;
  }
}

/** Doğrulama kodu emaili (gözəl şablon). */
export async function sendVerificationCode(to: string, code: string): Promise<boolean> {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a1a">
      <h2 style="margin:0 0 8px">tradixai — Email təsdiqi</h2>
      <p style="color:#555;margin:0 0 16px">Email ünvanınızı təsdiqləmək üçün kod:</p>
      <div style="font-size:32px;font-weight:bold;letter-spacing:6px;background:#f4f1ea;border-radius:12px;padding:16px;text-align:center;color:#e8590c">${code}</div>
      <p style="color:#888;font-size:13px;margin:16px 0 0">Kod 5 dəqiqə etibarlıdır. Bu emaili siz istəməmisinizsə, nəzərə almayın.</p>
    </div>`;
  return sendEmail(to, 'tradixai — Email təsdiq kodu', html);
}
