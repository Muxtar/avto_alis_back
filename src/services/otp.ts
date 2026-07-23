// Doğrulama kodu (OTP) yaratma + göndərmə — mərkəzi məntiq.
// Admin `otp_real` flag-ı aktivdirsə kod WhatsApp ilə göndərilir və cavabda
// gizlədilir; deaktivdirsə (fake/test) kod cavabda qaytarılır ki, input üstündə
// göstərilsin. `show_dev_code` aktivdirsə kod həmişə cavabda qaytarılır (debug).
import { PrismaClient } from '@prisma/client';
import { sendWhatsAppOtp } from './infobipWhatsApp';
import { resolveFlag } from './settings';

const prisma = new PrismaClient();

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
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
      delivered = (await sendWhatsAppOtp(u.phone, code)).delivered;
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
