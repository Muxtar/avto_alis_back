// Doğrulama kodu (OTP) yaratma + göndərmə — mərkəzi məntiq.
// Admin `otp_real` flag-ı aktivdirsə kod Infobip ilə (SMS və ya WhatsApp)
// göndərilir və cavabda ƏSLA qaytarılmır (təhlükəsizlik — kod yalnız istifadəçinin
// telefonuna gedir); deaktivdirsə (fake/test) kod cavabda qaytarılır ki, input
// üstündə göstərilsin.
import { PrismaClient } from '@prisma/client';
import { sendWhatsAppOtp } from './infobipWhatsApp';
import { sendSmsOtp, isSmsConfigured } from './infobipSms';
import { resolveFlag } from './settings';

const prisma = new PrismaClient();

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// OTP kanalı: sms (Infobip SMS) və ya whatsapp (Infobip WhatsApp).
// OTP_CHANNEL env ilə seçilir (köhnə INFOBIP_OTP_CHANNEL da dəstəklənir).
// Təyin olunmayıbsa: Infobip SMS konfiqurasiyalıdırsa sms, yoxsa whatsapp.
export type OtpChannel = 'sms' | 'whatsapp';
export function otpChannel(): OtpChannel {
  const c = (process.env.OTP_CHANNEL || process.env.INFOBIP_OTP_CHANNEL || '').toLowerCase();
  if (c === 'sms') return 'sms';
  if (c === 'whatsapp') return 'whatsapp';
  return isSmsConfigured() ? 'sms' : 'whatsapp';
}

export interface OtpResult {
  code: string;
  delivered: boolean; // Infobip ilə real göndərildi?
  showCode: boolean; // cavabda kod göstərilməlidir? (fake/debug/çatdırılmayıb)
}

export async function createOtp(userId: number): Promise<OtpResult> {
  const code = generateCode();
  await prisma.verificationCode.create({
    data: { userId, code, expiresAt: new Date(Date.now() + 5 * 60 * 1000) },
  });

  const realMode = await resolveFlag('otp_real');

  let delivered = false;
  if (realMode) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
    if (u?.phone) {
      // Seçilmiş kanala görə göndər — Infobip SMS və ya WhatsApp.
      const ch = otpChannel();
      delivered = ch === 'sms'
        ? (await sendSmsOtp(u.phone, code)).delivered
        : (await sendWhatsAppOtp(u.phone, code)).delivered;
    }
  }

  // Kodu cavabda göstər (input üstündə "fake") — YALNIZ test (fake) rejimində.
  // Real rejimdə kod ƏSLA cavabda getmir: yalnız istifadəçinin telefonuna SMS ilə
  // gedir. Beləliklə kod doğrulama səhifəsində görünmür (təhlükəsizlik).
  const showCode = !realMode;
  return { code, delivered, showCode };
}
