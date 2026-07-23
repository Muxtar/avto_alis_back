// Infobip WhatsApp OTP inteqrasiyası — telefon nömrəsi doğrulama kodunu
// (6 rəqəm) WhatsApp vasitəsilə göndərir.
//
// Bütün açarlar KODA YAZILMIR — Railway env dəyişənlərindən oxunur:
//   INFOBIP_API_KEY     — Infobip API açarı (portal → Developers → API Keys) [MƏCBURİ]
//   INFOBIP_BASE_URL    — hesaba özəl baza URL (məs. xxxxx.api.infobip.com) [MƏCBURİ]
//   INFOBIP_WA_SENDER   — qeydiyyatdan keçmiş WhatsApp göndərən nömrəsi     [MƏCBURİ]
//   INFOBIP_WA_TEMPLATE — təsdiqlənmiş WhatsApp "authentication" şablon adı [MƏCBURİ]
//   INFOBIP_WA_LANG     — şablon dili (default "en")                        [opsional]
//   INFOBIP_WA_OTP_BUTTON — "true" olsa şablona kopyala-kod (URL) düyməsi əlavə edilir [opsional]
//
// Şablon Meta/WhatsApp tərəfindən əvvəlcədən təsdiqlənməlidir (OTP üçün
// "authentication" kateqoriyalı, body-də bir {{1}} placeholder ilə).

const API_KEY = process.env.INFOBIP_API_KEY || '';
const RAW_BASE = process.env.INFOBIP_BASE_URL || '';
const SENDER = process.env.INFOBIP_WA_SENDER || '';
const TEMPLATE = process.env.INFOBIP_WA_TEMPLATE || '';
const LANG = process.env.INFOBIP_WA_LANG || 'en';
const OTP_BUTTON = process.env.INFOBIP_WA_OTP_BUTTON === 'true';

// Baza URL-i normallaşdır: sxem yoxdursa https əlavə et, sondakı "/" sil.
function baseUrl(): string {
  let b = RAW_BASE.trim();
  if (!b) return '';
  if (!/^https?:\/\//i.test(b)) b = `https://${b}`;
  return b.replace(/\/+$/, '');
}

export function isInfobipConfigured(): boolean {
  return !!(API_KEY && RAW_BASE && SENDER && TEMPLATE);
}

// WhatsApp/Infobip beynəlxalq formatı rəqəmlərlə istəyir (+ və boşluqlar silinir).
function toRecipient(phone: string): string {
  return String(phone || '').replace(/[^\d]/g, '');
}

export interface OtpSendResult {
  configured: boolean;
  delivered: boolean;
  error?: string;
}

// Doğrulama kodunu WhatsApp şablon mesajı ilə göndərir.
// Konfiqurasiya yoxdursa {configured:false} qaytarır (test rejimi saxlanılır).
export async function sendWhatsAppOtp(phone: string, code: string): Promise<OtpSendResult> {
  if (!isInfobipConfigured()) return { configured: false, delivered: false };

  const to = toRecipient(phone);
  if (!to) return { configured: true, delivered: false, error: 'invalid_phone' };

  // OTP "authentication" şablonu: body-də kod, opsional olaraq kopyala-kod düyməsi.
  const templateData: any = { body: { placeholders: [code] } };
  if (OTP_BUTTON) {
    templateData.buttons = [{ type: 'URL', parameter: code }];
  }

  const payload = {
    messages: [
      {
        from: SENDER,
        to,
        content: {
          templateName: TEMPLATE,
          templateData,
          language: LANG,
        },
      },
    ],
  };

  try {
    const res = await fetch(`${baseUrl()}/whatsapp/1/message/template`, {
      method: 'POST',
      headers: {
        Authorization: `App ${API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[infobip] WhatsApp OTP göndərilmədi:', res.status, text.slice(0, 500));
      return { configured: true, delivered: false, error: `http_${res.status}` };
    }

    const data: any = await res.json().catch(() => null);
    // Uğurlu təqdim: status qrupu PENDING/DELIVERED (rədd = REJECTED).
    const msg = data?.messages?.[0];
    const group = msg?.status?.groupName || msg?.status?.group;
    if (group && String(group).toUpperCase() === 'REJECTED') {
      console.error('[infobip] WhatsApp OTP rədd edildi:', JSON.stringify(msg?.status));
      return { configured: true, delivered: false, error: 'rejected' };
    }
    return { configured: true, delivered: true };
  } catch (e: any) {
    console.error('[infobip] WhatsApp OTP xətası:', e?.message || e);
    return { configured: true, delivered: false, error: 'network' };
  }
}
