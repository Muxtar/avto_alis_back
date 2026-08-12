// Xarici servislərin canlı sağlamlıq yoxlaması — admin panel üçün.
// Hər servis üçün: konfiqurasiya var/yox + (mümkünsə) canlı sınaqla işləyir/işləmir
// + xəta detalı (məs. Claude "kredit balansı azdır", Infobip balans qalığı).
//
// DİQQƏT: canlı yoxlamalar az miqdar token/kredit xərcləyə bilər (Claude probe,
// Tavily 1 kredit) — ona görə yalnız admin "Yoxla" düyməsinə basanda işə düşür.

import Anthropic from '@anthropic-ai/sdk';
import { isInfobipConfigured } from './infobipWhatsApp';
import { isSmsConfigured } from './infobipSms';
import { isVeriffConfigured } from './veriff';
import { isYangoConfigured, checkPrice as yangoCheckPrice } from './yangoDelivery';
import { isConfigured as isYigimConfigured } from './yigimPay';
import { isMailerConfigured } from './mailer';

export type HealthStatus = 'ok' | 'error' | 'configured' | 'not_configured';
export interface ServiceHealth {
  id: string;
  name: string;
  category: 'ai' | 'sms' | 'payment' | 'kyc' | 'delivery' | 'mail';
  configured: boolean;
  live: boolean;          // canlı sınaq edildimi (yoxsa yalnız konfiqurasiya yoxlaması)
  status: HealthStatus;
  detail: string;         // istifadəçiyə göstəriləcək qısa izah
  meta?: Record<string, any>; // əlavə (məs. balans)
}

const TIMEOUT_MS = 8000;

// ── Anthropic (Claude) — ən ucuz model ilə minimal çağırış; xətanı üzə çıxarır ──
async function checkAnthropic(): Promise<ServiceHealth> {
  const base: ServiceHealth = { id: 'anthropic', name: 'Claude (Anthropic)', category: 'ai', configured: false, live: false, status: 'not_configured', detail: 'ANTHROPIC_API_KEY yoxdur' };
  if (!process.env.ANTHROPIC_API_KEY) return base;
  base.configured = true; base.live = true;
  try {
    const client = new Anthropic();
    await client.messages.create(
      { model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
      { timeout: TIMEOUT_MS },
    );
    return { ...base, status: 'ok', detail: 'İşləyir — açar və balans qaydasındadır' };
  } catch (e: any) {
    const st = e?.status;
    const msg = String(e?.error?.error?.message || e?.message || '');
    let detail = `Xəta (${st || '?'})`;
    if (/credit balance is too low|insufficient|billing/i.test(msg)) detail = '⚠️ Kredit balansı azdır/bitib — Anthropic hesabına balans əlavə edin';
    else if (st === 401) detail = 'API açarı etibarsızdır (401)';
    else if (st === 429) detail = 'Sürət/istifadə limiti doldu (429)';
    else if (st === 404) detail = 'Sınaq modeli tapılmadı (404)';
    else if (st === 400 && msg) detail = msg.slice(0, 140);
    return { ...base, status: 'error', detail };
  }
}

// ── Tavily — minimal axtarış (1 kredit) ilə açar/işləmə yoxlaması ──
async function checkTavily(): Promise<ServiceHealth> {
  const base: ServiceHealth = { id: 'tavily', name: 'Tavily (internet axtarışı)', category: 'ai', configured: false, live: false, status: 'not_configured', detail: 'TAVILY_API_KEY yoxdur' };
  if (!process.env.TAVILY_API_KEY) return base;
  base.configured = true; base.live = true;
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query: 'ping', max_results: 1, search_depth: 'basic' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { ...base, status: 'ok', detail: 'İşləyir — açar aktivdir' };
    if (res.status === 401 || res.status === 403) return { ...base, status: 'error', detail: 'API açarı etibarsızdır (401/403)' };
    if (res.status === 429) return { ...base, status: 'error', detail: '⚠️ Kredit bitib və ya limit doldu (429)' };
    return { ...base, status: 'error', detail: `Xəta (HTTP ${res.status})` };
  } catch (e: any) {
    return { ...base, status: 'error', detail: e?.name === 'TimeoutError' ? 'Vaxt bitdi (timeout)' : 'Bağlantı xətası' };
  }
}

// ── Infobip — hesab balansını çəkir (SMS + WhatsApp eyni hesab) ──
async function checkInfobip(): Promise<ServiceHealth> {
  const wa = isInfobipConfigured(), sms = isSmsConfigured();
  const chans = [wa && 'WhatsApp', sms && 'SMS'].filter(Boolean).join(' + ') || 'yox';
  const base: ServiceHealth = { id: 'infobip', name: `Infobip (${chans})`, category: 'sms', configured: !!(wa || sms), live: false, status: 'not_configured', detail: 'INFOBIP_API_KEY/BASE_URL yoxdur' };
  const key = process.env.INFOBIP_API_KEY, rawBase = process.env.INFOBIP_BASE_URL;
  if (!key || !rawBase) return base;
  base.configured = true; base.live = true;
  let host = rawBase.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  try {
    const res = await fetch(`https://${host}/account/1/balance`, {
      headers: { Authorization: `App ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      const d: any = await res.json().catch(() => ({}));
      const bal = typeof d?.balance === 'number' ? d.balance : null;
      return { ...base, status: 'ok', detail: bal != null ? `İşləyir — balans: ${bal} ${d?.currency || ''}`.trim() : 'İşləyir', meta: { balance: bal, currency: d?.currency } };
    }
    if (res.status === 401) return { ...base, status: 'error', detail: 'API açarı etibarsızdır (401)' };
    return { ...base, status: 'error', detail: `Xəta (HTTP ${res.status})` };
  } catch (e: any) {
    return { ...base, status: 'error', detail: e?.name === 'TimeoutError' ? 'Vaxt bitdi (timeout)' : 'Bağlantı xətası' };
  }
}

// ── Yalnız konfiqurasiya yoxlaması olan servislər (canlı sınaq riskli/xərcli) ──
function configOnly(id: string, name: string, category: ServiceHealth['category'], ok: boolean, note = ''): ServiceHealth {
  return {
    id, name, category, configured: ok, live: false,
    status: ok ? 'configured' : 'not_configured',
    detail: ok ? (note || 'Konfiqurasiya olunub (canlı sınaq edilmir)') : 'Konfiqurasiya yoxdur',
  };
}

// Yango — CANLI yoxlama. Pulsuzdur (check-price sifariş yaratmır), ona görə
// real sorğu göndərib əsl xətanı göstəririk. "Host is not allowed" kimi
// cavabları admin panelində görmək lazımdır, əks halda səbəb gizli qalır.
async function checkYango(): Promise<ServiceHealth> {
  const base = { id: 'yango', name: 'Yango (çatdırılma)', category: 'delivery' as const };
  if (!isYangoConfigured()) {
    return { ...base, configured: false, live: false, status: 'not_configured', detail: 'YANGO_TOKEN qurulmayıb' };
  }
  try {
    // Bakı mərkəzindən Bakı mərkəzinə sınaq qiyməti — sifariş YARANMIR.
    // Geo formatı [uzunluq, en] — routes/yango.ts ilə eyni sıra.
    const q = await yangoCheckPrice({
      source: [49.8920, 40.3777],        // Bakı mərkəzi
      destination: [49.8671, 40.4093],   // Bakı, başqa nöqtə
      weightKg: 1,
    });
    if (q.ok && q.data?.price) {
      return { ...base, configured: true, live: true, status: 'ok', detail: `İşləyir — sınaq qiyməti alındı (${q.data.price})` };
    }
    const err = q.error || 'Qiymət alınmadı';
    // Ən çox rast gəlinən iki halı izahla göstəririk.
    const hint = /host is not allowed/i.test(err)
      ? ' → Yango serverimizin IP-sini tanımır. Admin paneldəki çıxış IP-sini Yango-ya verib ağ siyahıya saldırın.'
      : /access denied|unauthorized/i.test(err)
        ? ' → Token qəbul edilmir. YANGO_TOKEN-i yoxlayın.'
        : '';
    return { ...base, configured: true, live: true, status: 'error', detail: `${err}${hint}` };
  } catch (e: any) {
    return { ...base, configured: true, live: true, status: 'error', detail: e?.message || 'Yoxlama alınmadı' };
  }
}

export async function checkAllServices(): Promise<ServiceHealth[]> {
  const results = await Promise.allSettled([
    checkAnthropic(),
    checkTavily(),
    checkInfobip(),
    Promise.resolve(configOnly('veriff', 'Veriff (kimlik doğrulaması)', 'kyc', isVeriffConfigured())),
    checkYango(),
    Promise.resolve(configOnly('yigim', 'YIGIM (ödəniş)', 'payment', isYigimConfigured())),
    Promise.resolve(configOnly('mailer', 'Email (SMTP)', 'mail', isMailerConfigured())),
  ]);
  return results.map((r) => r.status === 'fulfilled' ? r.value
    : { id: 'unknown', name: 'Naməlum servis', category: 'ai', configured: false, live: false, status: 'error', detail: 'Yoxlama alınmadı' });
}
