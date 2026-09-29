// QEYDİYYATSIZ NÖMRƏYƏ MESAJ / RƏY SORĞUSU.
// İstifadəçi kontaktına platformada olmayan nömrə əlavə edib ona yaza, Rəy istəyə bilər.
// Yazılanlar PendingInvite-də gözləyir; həmin nömrə ilə profil TAMAMLANANDA (OTP ilə
// təsdiqlənmiş nömrə + ad) hamısı əsl mesaja / konsultasiya sorğusuna çevrilir,
// ilkin yazılma vaxtı saxlanılır.
import { PrismaClient } from '@prisma/client';
import { emitToUser } from './callSignaling';

const prisma = new PrismaClient();

/** Uyğunlaşdırma açarı — son 9 rəqəm (+994 50…, 050…, boşluqlu/suz eyni). */
export const phoneKeyOf = (phone: string | null | undefined) => String(phone || '').replace(/\D/g, '').slice(-9);

export const DEFAULT_CONSULT_MIN = 30;

export async function deliverPendingInvites(userId: number): Promise<number> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, phone: true, profileComplete: true } });
  if (!user?.profileComplete) return 0;
  const key = phoneKeyOf(user.phone);
  if (key.length < 7) return 0;
  const invites = await prisma.pendingInvite.findMany({ where: { phoneKey: key, deliveredAt: null }, orderBy: { id: 'asc' } });
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
        await tx.message.create({ data: { senderId: inv.senderId, receiverId: userId, content: inv.content, createdAt: inv.createdAt } });
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
