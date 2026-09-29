// QEYDİYYATSIZ NÖMRƏYƏ MESAJ / RƏY SORĞUSU.
// İstifadəçi kontaktına platformada olmayan nömrə əlavə edib ona yaza, Rəy istəyə bilər.
// Yazılanlar PendingInvite-də gözləyir; həmin nömrə ilə profil TAMAMLANANDA (OTP ilə
// təsdiqlənmiş nömrə + ad) hamısı əsl mesaja / konsultasiya sorğusuna çevrilir,
// ilkin yazılma vaxtı saxlanılır.
import { PrismaClient } from '@prisma/client';
import { emitToUser } from './callSignaling';
import { handleOf } from './socialVerify';

const prisma = new PrismaClient();

/** Uyğunlaşdırma açarı — son 9 rəqəm (+994 50…, 050…, boşluqlu/suz eyni). */
export const phoneKeyOf = (phone: string | null | undefined) => String(phone || '').replace(/\D/g, '').slice(-9);

export const DEFAULT_CONSULT_MIN = 30;

// Gözləyən mesajın media/növ sahələri — yalnız icazəli açarlar Message-ə keçir.
const PAYLOAD_KEYS = ['type', 'mediaUrl', 'mediaName', 'mediaMime', 'mediaSize', 'mediaDuration', 'contactPhone', 'contactUserId', 'latitude', 'longitude'] as const;
const MSG_TYPES = new Set(['TEXT', 'IMAGE', 'FILE', 'AUDIO', 'VIDEO', 'CONTACT', 'LOCATION']);
export function pickPayload(raw: unknown): Record<string, any> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, any> = {};
  for (const k of PAYLOAD_KEYS) { const v = (raw as any)[k]; if (v !== undefined && v !== null) out[k] = v; }
  if (out.type && !MSG_TYPES.has(out.type)) delete out.type;
  return out;
}

// Sosial hesab açarı: «facebook:muxtar.bayramov». Axtarış nəticəsi (x) və profil
// linki (twitter) eyni platforma sayılır; post/qrup/səhifə linkləri qəbul edilmir.
const SOCIAL_ALIASES: Record<string, string> = { x: 'twitter', fb: 'facebook', ig: 'instagram' };
const SOCIAL_OK = new Set(['facebook', 'instagram', 'linkedin', 'twitter', 'tiktok', 'youtube', 'telegram']);
const NOT_A_PROFILE = new Set(['p', 'reel', 'reels', 'tv', 'stories', 'explore', 'watch', 'groups', 'events', 'pages', 'photo', 'photos',
  'video', 'videos', 'posts', 'status', 'share', 'permalink.php', 'profile.php', 'shorts', 'playlist', 'results', 'hashtag', 'search',
  'jobs', 'feed', 'pulse', 'story', 'login', 'home', 'people', 'public']);
export function socialKeyOf(platform: string, url: string): string | null {
  const p = SOCIAL_ALIASES[String(platform || '').toLowerCase()] || String(platform || '').toLowerCase();
  if (!SOCIAL_OK.has(p)) return null;
  const h = handleOf(url);
  if (!h || NOT_A_PROFILE.has(h) || !/^[a-z0-9._-]{2,80}$/.test(h)) return null;
  return `${p}:${h}`;
}

/**
 * Gözləyənləri çatdır: (1) istifadəçinin OTP ilə təsdiqlənmiş NÖMRƏSİNƏ yazılanlar,
 * (2) onun TƏSDİQLƏNMİŞ sosial hesablarına (bio kodu / admin) yazılanlar.
 * Profil tamamlananda və sosial hesab təsdiqlənəndə çağırılır; təkrar çağırış zərərsizdir.
 */
export async function deliverPendingInvites(userId: number): Promise<number> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, phone: true, profileComplete: true } });
  if (!user?.profileComplete) return 0;
  const key = phoneKeyOf(user.phone);
  const links = await prisma.socialLink.findMany({ where: { userId, verified: true }, select: { platform: true, url: true } });
  const socialKeys = links.map((l) => socialKeyOf(l.platform, l.url)).filter((k): k is string => !!k);
  const or: any[] = [];
  if (key.length >= 7) or.push({ phoneKey: key });
  if (socialKeys.length) or.push({ social: { in: socialKeys } });
  if (!or.length) return 0;
  const invites = await prisma.pendingInvite.findMany({ where: { deliveredAt: null, OR: or }, orderBy: { id: 'asc' } });
  if (!invites.length) return 0;

  const blocks = await prisma.blockedUser.findMany({
    where: { OR: [{ blockerId: userId, blockedId: { in: invites.map((i) => i.senderId) } }, { blockedId: userId, blockerId: { in: invites.map((i) => i.senderId) } }] },
    select: { blockerId: true, blockedId: true },
  });
  const blocked = new Set(blocks.map((b) => (b.blockerId === userId ? b.blockedId : b.blockerId)));
  const senders = new Map<number, { messages: number; consults: number }>();
  let n = 0;

  for (const inv of invites) {
    // Özünə yazılmış (nadir: göndərən sonradan nömrəsini dəyişib) və ya blok — çatdırılmır, bağlanır.
    if (inv.senderId === userId || blocked.has(inv.senderId)) {
      await prisma.pendingInvite.update({ where: { id: inv.id }, data: { deliveredAt: new Date(), deliveredToId: null } });
      continue;
    }
    await prisma.$transaction(async (tx) => {
      if (inv.kind === 'CONSULTATION') {
        const min = inv.durationMinutes || DEFAULT_CONSULT_MIN;
        // Qiymət 0 — peşəkarın hələ təklifi yoxdur; QƏBUL edəndə qiyməti özü yazır.
        const s = await tx.consultationSession.create({
          data: {
            buyerId: inv.senderId, professionalId: userId, offerId: null, title: 'Rəy sorğusu',
            price: 0, blockSeconds: min * 60, durationSeconds: min * 60, status: 'REQUESTED', createdAt: inv.createdAt,
          },
        });
        await tx.message.create({
          data: {
            senderId: inv.senderId, receiverId: userId, consultationId: s.id, createdAt: inv.createdAt,
            content: `🗣️ Rəy sorğusu — ${min} dəq. Qiyməti qəbul edəndə siz yazırsınız.` + (inv.content ? `\n${inv.content}` : ''),
          },
        });
        await tx.notification.create({ data: { userId, type: 'CONSULTATION', title: 'Sizdən Rəy istəyirlər', body: 'Qeydiyyatdan əvvəl sizə Rəy sorğusu göndərilib — qiymət yazıb qəbul edə bilərsiniz.', link: `/consultations/${s.id}` } });
      } else {
        const extra = pickPayload(inv.payload);
        await tx.message.create({ data: { senderId: inv.senderId, receiverId: userId, content: inv.content, createdAt: inv.createdAt, ...extra } });
      }
      await tx.pendingInvite.update({ where: { id: inv.id }, data: { deliveredAt: new Date(), deliveredToId: userId } });
    });
    const s = senders.get(inv.senderId) || { messages: 0, consults: 0 };
    if (inv.kind === 'CONSULTATION') s.consults++; else s.messages++;
    senders.set(inv.senderId, s);
    n++;
  }

  // Göndərənlərə xəbər: «X qeydiyyatdan keçdi — yazdıqlarınız çatdırıldı».
  for (const [sid, c] of senders) {
    const what = [c.messages && `${c.messages} mesaj`, c.consults && `${c.consults} Rəy sorğusu`].filter(Boolean).join(' və ');
    await prisma.notification.create({ data: { userId: sid, type: 'MESSAGE', title: `${user.name || 'Kontaktınız'} platformaya qoşuldu`, body: `Əvvəl yazdığınız ${what} çatdırıldı.`, link: '/messages' } }).catch(() => {});
    emitToUser(sid, 'invites:delivered', { userId, name: user.name });
  }
  return n;
}
