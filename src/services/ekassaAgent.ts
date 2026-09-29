// E-KASSA AGENTİ — portal yalnız Azərbaycan IP-lərinə açıqdır (40 ölkədən yoxlanılıb:
// hamısı timeout). Bakıdakı istənilən kompüterdə işləyən kiçik agent (tools/ekassa-agent)
// serverə ÖZÜ qoşulur (long-poll), növbədəki fiskal ID-ləri götürür, çeki e-kassadan
// yükləyib geri göndərir. Port açmaq, domen, VPS lazım deyil.
//   Railway env: EKASSA_AGENT_KEY=<≥24 simvol gizli açar>  (agentdə eyni açar)
import crypto from 'crypto';

const KEY = process.env.EKASSA_AGENT_KEY || '';
export const agentEnabled = () => KEY.length >= 24;
export const agentKeyOk = (k: unknown) => {
  if (!agentEnabled() || typeof k !== 'string' || k.length !== KEY.length) return false;
  return crypto.timingSafeEqual(Buffer.from(k), Buffer.from(KEY));
};

type Result = { status: number; type: string; body: Buffer };
type Job = { fiscalId: string; resolve: (r: Result) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; taken: boolean };

const jobs = new Map<string, Job[]>();      // fiskal ID → gözləyənlər (eyni çek bir dəfə yüklənir)
const queue: string[] = [];                 // hələ agentə verilməmiş ID-lər
const waiters: ((id: string | null) => void)[] = []; // boşda gözləyən agent sorğuları
let lastSeen = 0;

/** Agent son 40 saniyədə serverə qoşulubmu (long-poll 25 san). */
export const agentOnline = () => agentEnabled() && Date.now() - lastSeen < 40_000;
export const agentLastSeen = () => lastSeen;

/** Çeki agent vasitəsilə al. Agent yoxdursa və ya vaxtında cavab vermirsə — xəta. */
export function fetchViaAgent(fiscalId: string, timeoutMs = 20_000): Promise<Result> {
  return new Promise((resolve, reject) => {
    const job: Job = {
      fiscalId, resolve, reject, taken: false,
      timer: setTimeout(() => { drop(fiscalId, job); reject(new Error('agent timeout')); }, timeoutMs),
    };
    const list = jobs.get(fiscalId);
    if (list) { list.push(job); return; }
    jobs.set(fiscalId, [job]);
    const w = waiters.shift();
    if (w) w(fiscalId); else queue.push(fiscalId);
  });
}

function drop(fiscalId: string, job: Job) {
  const list = jobs.get(fiscalId);
  if (!list) return;
  const rest = list.filter((j) => j !== job);
  if (rest.length) jobs.set(fiscalId, rest);
  else { jobs.delete(fiscalId); const i = queue.indexOf(fiscalId); if (i >= 0) queue.splice(i, 1); }
}

/** Agentin long-poll sorğusu: növbədə iş varsa dərhal, yoxsa ≤25 san gözlə. */
export function nextJob(waitMs = 25_000): Promise<string | null> {
  lastSeen = Date.now();
  const id = queue.shift();
  if (id) return Promise.resolve(id);
  return new Promise((resolve) => {
    const w = (v: string | null) => { clearTimeout(t); lastSeen = Date.now(); resolve(v); };
    const t = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); lastSeen = Date.now(); resolve(null); }, waitMs);
    waiters.push(w);
  });
}

/** Agent nəticəni göndərdi (status 200 — çek şəkli, 209/404 — tapılmadı, 0 — agent portala çata bilmədi). */
export function completeJob(fiscalId: string, r: Result) {
  lastSeen = Date.now();
  const list = jobs.get(fiscalId);
  if (!list) return false;
  jobs.delete(fiscalId);
  for (const j of list) { clearTimeout(j.timer); j.resolve(r); }
  return true;
}
