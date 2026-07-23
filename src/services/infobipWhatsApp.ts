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
// Göndərən nömrə də rəqəmlərlə olmalıdır — "+44 7860 088970" → "447860088970".
// (Infobip `from` sahəsi + və boşluq qəbul etmir.)
const SENDER = (process.env.INFOBIP_WA_SENDER || '').replace(/[^\d]/g, '');
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
  detail?: string;
}

// Konfiqurasiya vəziyyəti — admin diaqnostikası üçün (dəyərlər açıqlanmır,
// yalnız var/yox). templateName və sender diaqnostika üçün göstərilir.
export function infobipStatus() {
  const missing: string[] = [];
  if (!API_KEY) missing.push('INFOBIP_API_KEY');
  if (!RAW_BASE) missing.push('INFOBIP_BASE_URL');
  if (!SENDER) missing.push('INFOBIP_WA_SENDER');
  if (!TEMPLATE) missing.push('INFOBIP_WA_TEMPLATE');
  return {
    configured: isInfobipConfigured(),
    missing,
    templateName: TEMPLATE || null,
    sender: SENDER || null,
    language: LANG,
    otpButton: OTP_BUTTON,
    baseUrl: RAW_BASE ? baseUrl().replace(/^https?:\/\//, '') : null,
  };
}

export interface SendDetail {
  ok: boolean;
  status: number; // HTTP status (0 = şəbəkə/konfiqurasiya)
  error?: string; // qısa kod
  detail?: string; // Infobip cavabı / xəta mətni (diaqnostika üçün)
}

// Aşağı səviyyəli şablon göndərmə — tam diaqnostika qaytarır.
async function sendTemplate(phone: string, code: string): Promise<SendDetail> {
  if (!isInfobipConfigured()) {
    return { ok: false, status: 0, error: 'not_configured', detail: 'Env dəyişənləri tam deyil: ' + infobipStatus().missing.join(', ') };
  }
  const to = toRecipient(phone);
  if (!to) return { ok: false, status: 0, error: 'invalid_phone', detail: 'Nömrə düzgün deyil' };

  // OTP "authentication" şablonu: body-də kod, opsional kopyala-kod düyməsi.
  const templateData: any = { body: { placeholders: [code] } };
  if (OTP_BUTTON) templateData.buttons = [{ type: 'URL', parameter: code }];

  const payload = {
    messages: [{ from: SENDER, to, content: { templateName: TEMPLATE, templateData, language: LANG } }],
  };

  try {
    const res = await fetch(`${baseUrl()}/whatsapp/1/message/template`, {
      method: 'POST',
      headers: { Authorization: `App ${API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text().catch(() => '');
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* mətn kimi qalır */ }

    if (!res.ok) {
      // Infobip xəta mətni — səbəbi göstərir (məs. şablon adı yanlış, sender yoxdur...).
      const reason = data?.requestError?.serviceException?.text || text.slice(0, 800);
      console.error('[infobip] WhatsApp göndərilmədi:', res.status, reason);
      return { ok: false, status: res.status, error: `http_${res.status}`, detail: reason };
    }

    const msg = data?.messages?.[0];
    const group = String(msg?.status?.groupName || msg?.status?.group || '').toUpperCase();
    if (group === 'REJECTED') {
      const reason = msg?.status?.description || JSON.stringify(msg?.status || {});
      console.error('[infobip] WhatsApp rədd edildi:', reason);
      return { ok: false, status: res.status, error: 'rejected', detail: reason };
    }
    return { ok: true, status: res.status, detail: msg?.status?.description || group || 'PENDING' };
  } catch (e: any) {
    console.error('[infobip] WhatsApp xətası:', e?.message || e);
    return { ok: false, status: 0, error: 'network', detail: e?.message || 'Şəbəkə xətası' };
  }
}

// Doğrulama kodunu WhatsApp ilə göndərir (OTP axını üçün).
export async function sendWhatsAppOtp(phone: string, code: string): Promise<OtpSendResult> {
  const r = await sendTemplate(phone, code);
  return { configured: isInfobipConfigured(), delivered: r.ok, error: r.error, detail: r.detail };
}

// Admin diaqnostikası — verilmiş nömrəyə test kodu göndərir, tam nəticə qaytarır.
export async function testWhatsApp(phone: string): Promise<SendDetail & ReturnType<typeof infobipStatus>> {
  const r = await sendTemplate(phone, '123456');
  return { ...infobipStatus(), ...r };
}
