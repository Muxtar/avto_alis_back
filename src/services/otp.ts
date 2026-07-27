// Doğrulama kodu (OTP) yaratma + göndərmə — mərkəzi məntiq.
// Admin `otp_real` flag-ı aktivdirsə kod Infobip ilə (SMS və ya WhatsApp)
// göndərilir və cavabda ƏSLA qaytarılmır (təhlükəsizlik — kod yalnız istifadəçinin
// telefonuna gedir); deaktivdirsə (fake/test) kod cavabda qaytarılır ki, input
// üstündə göstərilsin.
import { PrismaClient } from '@prisma/client';
import { sendWhatsAppOtp, isInfobipConfigured } from './infobipWhatsApp';
import { sendSmsOtp, isSmsConfigured } from './infobipSms';
import { resolveFlag } from './settings';

const prisma = new PrismaClient();

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// OTP kanalı: sms, whatsapp, və ya both (əvvəl WhatsApp, çatmasa SMS).
// OTP_CHANNEL env ilə seçilir (köhnə INFOBIP_OTP_CHANNEL da dəstəklənir).
// Təyin olunmayıbsa: hər ikisi konfiqurasiyalıdırsa "both", yoxsa mövcud olan.
export type OtpChannel = 'sms' | 'whatsapp' | 'both';
export function otpChannel(): OtpChannel {
  const c = (process.env.OTP_CHANNEL || process.env.INFOBIP_OTP_CHANNEL || '').toLowerCase();
  if (c === 'sms') return 'sms';
  if (c === 'whatsapp') return 'whatsapp';
  if (c === 'both') return 'both';
  const wa = isInfobipConfigured(), sms = isSmsConfigured();
  if (wa && sms) return 'both';   // ikisi də hazırdırsa: WhatsApp → SMS fallback
  if (wa) return 'whatsapp';
  return 'sms';
}

export interface OtpResult {
  code: string;
  delivered: boolean; // Infobip ilə real göndərildi?
  showCode: boolean; // cavabda kod göstərilməlidir? (fake/debug/çatdırılmayıb)
  channel?: string;  // real çatan kanal: 'whatsapp' | 'sms'
}

export async function createOtp(userId: number): Promise<OtpResult> {
  const code = generateCode();
  await prisma.verificationCode.create({
    data: { userId, code, expiresAt: new Date(Date.now() + 5 * 60 * 1000) },
  });

  const realMode = await resolveFlag('otp_real');

  let delivered = false;
  let usedChannel: string | undefined;
  if (realMode) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
    if (u?.phone) {
      const ch = otpChannel();
      // ƏVVƏL WhatsApp (whatsapp və ya both) — çatarsa kifayətdir.
      if (ch === 'whatsapp' || ch === 'both') {
        const wa = await sendWhatsAppOtp(u.phone, code);
        if (wa.delivered) { delivered = true; usedChannel = 'whatsapp'; }
      }
      // WhatsApp çatmadısa SMS (sms və ya both) — fallback.
      if (!delivered && (ch === 'sms' || ch === 'both')) {
        const sms = await sendSmsOtp(u.phone, code);
        if (sms.delivered) { delivered = true; usedChannel = 'sms'; }
      }
    }
  }

  // Kodu cavabda göstər (input üstündə "fake") — YALNIZ test (fake) rejimində.
  // Real rejimdə kod ƏSLA cavabda getmir: yalnız istifadəçinin telefonuna gedir.
  const showCode = !realMode;
  return { code, delivered, showCode, channel: usedChannel };
}
