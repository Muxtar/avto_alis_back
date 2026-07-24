// Infobip SMS OTP inteqrasiyası — telefon nömrəsi doğrulama kodunu SMS ilə göndərir.
// SMS WhatsApp-dan sadədir: şablon təsdiqi / Meta biznes doğrulaması / WABA lazım
// deyil — yalnız API açarı + baza URL + göndərən (sender) kifayətdir.
//
// Env (Railway):
//   INFOBIP_API_KEY   — Infobip API açarı (WhatsApp ilə eynidir)          [MƏCBURİ]
//   INFOBIP_BASE_URL  — hesaba özəl baza URL (məs. xxxxx.api.infobip.com) [MƏCBURİ]
//   INFOBIP_SMS_SENDER — göndərən adı/nömrəsi (alfanumerik "Tradixai" və ya nömrə) [MƏCBURİ]
//   INFOBIP_SMS_TEXT  — mesaj mətni; {code} əvəz olunur                    [opsional]

const API_KEY = process.env.INFOBIP_API_KEY || '';
const RAW_BASE = process.env.INFOBIP_BASE_URL || '';
const SMS_SENDER = process.env.INFOBIP_SMS_SENDER || '';
const SMS_TEXT = process.env.INFOBIP_SMS_TEXT || 'Tradixai tesdiq kodu: {code}. Kodu hec kimle paylasmayin.';

function baseUrl(): string {
  let b = RAW_BASE.trim();
  if (!b) return '';
  if (!/^https?:\/\//i.test(b)) b = `https://${b}`;
  return b.replace(/\/+$/, '');
}

export function isSmsConfigured(): boolean {
  return !!(API_KEY && RAW_BASE && SMS_SENDER);
}

function toRecipient(phone: string): string {
  return String(phone || '').replace(/[^\d]/g, '');
}

export function smsStatus() {
  const missing: string[] = [];
  if (!API_KEY) missing.push('INFOBIP_API_KEY');
  if (!RAW_BASE) missing.push('INFOBIP_BASE_URL');
  if (!SMS_SENDER) missing.push('INFOBIP_SMS_SENDER');
  return {
    configured: isSmsConfigured(),
    missing,
    sender: SMS_SENDER || null,
    baseUrl: RAW_BASE ? baseUrl().replace(/^https?:\/\//, '') : null,
  };
}

export interface SmsSendDetail {
  ok: boolean;
  status: number;
  error?: string;
  detail?: string;
}

async function sendSms(phone: string, code: string): Promise<SmsSendDetail> {
  if (!isSmsConfigured()) {
    return { ok: false, status: 0, error: 'not_configured', detail: 'Env dəyişənləri tam deyil: ' + smsStatus().missing.join(', ') };
  }
  const to = toRecipient(phone);
  if (!to) return { ok: false, status: 0, error: 'invalid_phone', detail: 'Nömrə düzgün deyil' };

  const text = SMS_TEXT.replace('{code}', code);
  const payload = {
    messages: [{ from: SMS_SENDER, destinations: [{ to }], text }],
  };

  try {
    const res = await fetch(`${baseUrl()}/sms/2/text/advanced`, {
      method: 'POST',
      headers: { Authorization: `App ${API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const bodyText = await res.text().catch(() => '');
    let data: any = null;
    try { data = JSON.parse(bodyText); } catch { /* mətn kimi qalır */ }

    if (!res.ok) {
      const reason = data?.requestError?.serviceException?.text || bodyText.slice(0, 800);
      console.error('[infobip] SMS göndərilmədi:', res.status, reason);
      return { ok: false, status: res.status, error: `http_${res.status}`, detail: reason };
    }
    const msg = data?.messages?.[0];
    const group = String(msg?.status?.groupName || msg?.status?.group || '').toUpperCase();
    if (group === 'REJECTED') {
      const reason = msg?.status?.description || JSON.stringify(msg?.status || {});
      console.error('[infobip] SMS rədd edildi:', reason);
      return { ok: false, status: res.status, error: 'rejected', detail: reason };
    }
    return { ok: true, status: res.status, detail: msg?.status?.description || group || 'PENDING' };
  } catch (e: any) {
    console.error('[infobip] SMS xətası:', e?.message || e);
    return { ok: false, status: 0, error: 'network', detail: e?.message || 'Şəbəkə xətası' };
  }
}

export async function sendSmsOtp(phone: string, code: string): Promise<{ configured: boolean; delivered: boolean; error?: string; detail?: string }> {
  const r = await sendSms(phone, code);
  return { configured: isSmsConfigured(), delivered: r.ok, error: r.error, detail: r.detail };
}

// Admin diaqnostikası — verilmiş nömrəyə test SMS göndərir, tam nəticə qaytarır.
export async function testSms(phone: string): Promise<SmsSendDetail & ReturnType<typeof smsStatus>> {
  const r = await sendSms(phone, '123456');
  return { ...smsStatus(), ...r };
}
