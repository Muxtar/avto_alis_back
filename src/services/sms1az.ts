// 1sms.az SMS OTP inteqrasiyası — doğrulama kodunu SMS ilə göndərir.
// 1sms.az yerli provayderdir (Azercell/Bakcell/Nar-a birbaşa marşrut), ona görə
// Infobip-dəki "route not available" və ya Vonage trial məhdudiyyəti yoxdur.
//
// Env (Railway):
//   ONESMS_API_KEY   — 1sms.az API açarı (Bearer token)        [MƏCBURİ]
//   ONESMS_SENDER    — təsdiqlənmiş göndərən adı (məs. Tradixai) [MƏCBURİ]
//   ONESMS_API_URL   — SMS endpoint; default 1sms.az/api/sms/send [opsional]
//   ONESMS_SMS_TEXT  — mesaj mətni; {code} əvəz olunur           [opsional]
//
// QEYD: dəqiq endpoint/parametr adları 1sms.az hesabındakı rəsmi API sənədi ilə
// təsdiqlənməlidir. Fərq olsa, ONESMS_API_URL env ilə endpoint dəyişilə bilər;
// parametr adları dəyişərsə buildToBody() funksiyası yenilənir.

const API_KEY = process.env.ONESMS_API_KEY || '';
const SENDER = process.env.ONESMS_SENDER || '';
const API_URL = process.env.ONESMS_API_URL || 'https://1sms.az/api/sms/send';
const SMS_TEXT = process.env.ONESMS_SMS_TEXT || 'Tradixai tesdiq kodu: {code}. Kodu hec kimle paylasmayin.';

export function is1smsConfigured(): boolean {
  return !!(API_KEY && SENDER);
}

// 1sms.az beynəlxalq format gözləyir (məs. +994501234567). Yalnız rəqəmləri
// saxlayırıq və başına "+" əlavə edirik.
function toRecipient(phone: string): string {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  return digits ? `+${digits}` : '';
}

export function sms1Status() {
  const missing: string[] = [];
  if (!API_KEY) missing.push('ONESMS_API_KEY');
  if (!SENDER) missing.push('ONESMS_SENDER');
  return { configured: is1smsConfigured(), missing, sender: SENDER || null, baseUrl: API_URL };
}

export interface Sms1SendDetail {
  ok: boolean;
  status: number;
  error?: string;
  detail?: string;
}

async function sendSms(phone: string, code: string): Promise<Sms1SendDetail> {
  if (!is1smsConfigured()) {
    return { ok: false, status: 0, error: 'not_configured', detail: 'Env dəyişənləri tam deyil: ' + sms1Status().missing.join(', ') };
  }
  const to = toRecipient(phone);
  if (!to) return { ok: false, status: 0, error: 'invalid_phone', detail: 'Nömrə düzgün deyil' };

  const message = SMS_TEXT.replace('{code}', code);
  const body = JSON.stringify({ to, message, senderName: SENDER });

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body,
    });
    const bodyText = await res.text().catch(() => '');
    let data: any = null;
    try { data = JSON.parse(bodyText); } catch { /* mətn cavab */ }

    if (!res.ok) {
      console.error('[1sms] SMS HTTP xətası:', res.status, bodyText.slice(0, 500));
      return { ok: false, status: res.status, error: `http_${res.status}`, detail: bodyText.slice(0, 500) };
    }
    // Uğur əlaməti: cavabda smsId/id və ya error olmaması. Provayder cavab
    // formatı fərqli ola bilər — ona görə çevik yoxlama edirik.
    const failed = data && (data.error || data.errorCode || data.status === 'error' || data.success === false);
    if (failed) {
      const reason = data.error || data.message || data.errorMessage || `xəta: ${bodyText.slice(0, 200)}`;
      console.error('[1sms] SMS rədd edildi:', reason);
      return { ok: false, status: res.status, error: 'rejected', detail: String(reason) };
    }
    const id = data?.smsId ?? data?.id ?? data?.messageId ?? '-';
    return { ok: true, status: res.status, detail: `accepted (id: ${id})` };
  } catch (e: any) {
    console.error('[1sms] SMS xətası:', e?.message || e);
    return { ok: false, status: 0, error: 'network', detail: e?.message || 'Şəbəkə xətası' };
  }
}

export async function send1smsOtp(phone: string, code: string): Promise<{ configured: boolean; delivered: boolean; error?: string; detail?: string }> {
  const r = await sendSms(phone, code);
  return { configured: is1smsConfigured(), delivered: r.ok, error: r.error, detail: r.detail };
}

export async function test1sms(phone: string): Promise<Sms1SendDetail & ReturnType<typeof sms1Status>> {
  const r = await sendSms(phone, '123456');
  return { ...sms1Status(), ...r };
}
