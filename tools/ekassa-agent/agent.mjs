// E-KASSA AGENTİ — Azərbaycandakı istənilən kompüterdə (ev/ofis kompüteri, Raspberry Pi, AZ VPS).
// e-kassa portalı YALNIZ Azərbaycan IP-lərinə açıqdır; bu agent serverə özü qoşulur (long-poll),
// növbədəki çekləri e-kassadan yükləyib serverə göndərir. Port açmaq / domen lazım deyil.
// Asılılıq yoxdur, Node 18+.
//
//   AGENT_KEY=<Railway-dəki EKASSA_AGENT_KEY> node agent.mjs
//   (istəyə görə) API=https://avtoalisback-production.up.railway.app/api
//
// Yalnız e-kassanın çek endpointinə sorğu göndərir — başqa ünvana heç nə ötürmür.
const API = (process.env.API || 'https://avtoalisback-production.up.railway.app/api').replace(/\/+$/, '');
const KEY = process.env.AGENT_KEY || '';
const FISCAL_RE = /^[A-HJ-NP-Za-km-z1-9]{10,64}$/;
if (KEY.length < 24) { console.error('AGENT_KEY ən azı 24 simvol olmalıdır (Railway EKASSA_AGENT_KEY ilə eyni)'); process.exit(1); }
const H = { 'X-Agent-Key': KEY };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toLocaleTimeString('az-AZ'), ...a);

async function handle(id) {
  let status = 0, type = 'text/plain', body = Buffer.alloc(0);
  try {
    const r = await fetch(`https://monitoring.e-kassa.gov.az/pks-monitoring/2.0.0/documents/${encodeURIComponent(id)}`, {
      headers: { 'User-Lang': 'az', Accept: 'image/*' }, signal: AbortSignal.timeout(12000),
    });
    status = r.status; type = r.headers.get('content-type') || 'application/octet-stream';
    body = Buffer.from(await r.arrayBuffer());
  } catch (e) { log('e-kassa xətası:', e?.cause?.code || e?.message); }
  await fetch(`${API}/ekassa-agent/result/${encodeURIComponent(id)}`, {
    method: 'POST', headers: { ...H, 'Content-Type': type, 'X-Ekassa-Status': String(status) }, body,
  }).catch((e) => log('nəticə göndərilmədi:', e?.message));
  log(`${id.slice(0, 10)}… → ${status} (${Math.round(body.length / 1024)} KB)`);
}

log('e-kassa agenti işləyir →', API);
let fails = 0, connected = false;
for (;;) {
  try {
    const r = await fetch(`${API}/ekassa-agent/next`, { headers: H, signal: AbortSignal.timeout(40000) });
    if (r.status === 401) { log('Açar səhvdir (401) — AGENT_KEY Railway-dəki EKASSA_AGENT_KEY ilə eyni olmalıdır'); connected = false; await sleep(60000); continue; }
    if (!connected) { connected = true; log('✓ serverə qoşuldu — çek gözlənilir'); }
    fails = 0;
    if (r.status === 200) {
      const { fiscalId } = await r.json();
      if (FISCAL_RE.test(fiscalId || '')) handle(fiscalId); // paralel — növbəti işi gözləmədən götür
    }
  } catch (e) {
    fails++; connected = false; log('serverə qoşulmaq alınmadı:', e?.cause?.code || e?.message);
    await sleep(Math.min(30000, 1000 * 2 ** Math.min(fails, 5)));
  }
}
