// Doğrulama kodu (OTP) yaratma + göndərmə — mərkəzi məntiq.
// Admin `otp_real` flag-ı aktivdirsə kod WhatsApp ilə göndərilir və cavabda
// gizlədilir; deaktivdirsə (fake/test) kod cavabda qaytarılır ki, input üstündə
// göstərilsin. `show_dev_code` aktivdirsə kod həmişə cavabda qaytarılır (debug).
import { PrismaClient } from '@prisma/client';
import { sendWhatsAppOtp } from './infobipWhatsApp';
import { sendSmsOtp, isSmsConfigured } from './infobipSms';
import { sendVonageOtp, isVonageConfigured } from './vonageSms';
import { resolveFlag } from './settings';

const prisma = new PrismaClient();

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// OTP kanalı: vonage (SMS), sms (Infobip) və ya whatsapp (Infobip).
// OTP_CHANNEL env ilə seçilir (köhnə INFOBIP_OTP_CHANNEL da dəstəklənir).
// Təyin olunmayıbsa: Vonage konfiqurasiyalıdırsa vonage, sonra Infobip SMS, yoxsa WhatsApp.
export type OtpChannel = 'vonage' | 'sms' | 'whatsapp';
export function otpChannel(): OtpChannel {
  const c = (process.env.OTP_CHANNEL || process.env.INFOBIP_OTP_CHANNEL || '').toLowerCase();
  if (c === 'vonage') return 'vonage';
  if (c === 'sms') return 'sms';
  if (c === 'whatsapp') return 'whatsapp';
  if (isVonageConfigured()) return 'vonage';
  return isSmsConfigured() ? 'sms' : 'whatsapp';
}

export interface OtpResult {
  code: string;
  delivered: boolean; // WhatsApp ilə real göndərildi?
  showCode: boolean; // cavabda kod göstərilməlidir? (fake/debug/çatdırılmayıb)
}

export async function createOtp(userId: number): Promise<OtpResult> {
  const code = generateCode();
  await prisma.verificationCode.create({
    data: { userId, code, expiresAt: new Date(Date.now() + 5 * 60 * 1000) },
  });

  const realMode = await resolveFlag('otp_real');
  const showDev = await resolveFlag('show_dev_code');

  let delivered = false;
  if (realMode) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
    if (u?.phone) {
      // Seçilmiş kanala görə göndər — Vonage SMS / Infobip SMS / WhatsApp.
      const ch = otpChannel();
      delivered = ch === 'vonage'
        ? (await sendVonageOtp(u.phone, code)).delivered
        : ch === 'sms'
          ? (await sendSmsOtp(u.phone, code)).delivered
          : (await sendWhatsAppOtp(u.phone, code)).delivered;
    }
  }

  // Kodu cavabda göstər (input üstündə "fake"):
  //  • test (fake) rejimində HƏMİŞƏ göstərilir,
  //  • real rejimdə GÖSTƏRİLMİR — kod yalnız WhatsApp-a gedir (göndərmə alınmasa
  //    belə fake göstərmirik ki, admin problemi görsün; debug flag-ı istisna),
  //  • show_dev_code aktivdirsə həmişə göstərilir (yalnız developer üçün).
  const showCode = showDev || !realMode;
  return { code, delivered, showCode };
}
