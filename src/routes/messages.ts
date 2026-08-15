import { Router, Response } from 'express';
import { Prisma, PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { messageLimiter } from '../middleware/rateLimiter';
import { emitToUser, isUserOnline } from '../services/callSignaling';
import { chatUpload } from '../middleware/upload';

const router = Router();
const prisma = new PrismaClient();

// Mesajın müştəriyə göndərilən standart forması (göndərən, reaksiyalar, cavab).
const msgInclude = {
  sender: { select: { id: true, name: true, avatar: true } },
  listing: { select: { id: true, title: true } },
  // Hansı biznes obyektinə (filial) aid olduğu — chat-da göstərilir.
  businessObject: { select: { id: true, name: true, city: true } },
  reactions: { select: { userId: true, emoji: true } },
  replyTo: { select: { id: true, content: true, senderId: true, deletedAt: true, type: true, mediaName: true } },
} as const;

// ── SÖHBƏT SEQMENTİ ───────────────────────────────────────────────────────
// Bir mesaj ya ŞƏXSİ profil üzərindən, ya da BİZNES (məhsul/obyekt) üzərindən
// gəlir. Fərqi tək bir şeydən bilinir: mesajda məhsul (listingId) və ya biznes
// obyekti (businessObjectId) konteksti varmı.
//
// Bu ayrım vacibdir: eyni şəxs həm dostun, həm də müştərin ola bilər. İki axın
// bir söhbətə tökülsə, satıcı hansı mesajın alış-verişə aid olduğunu itirir.
// Ona görə hər tərəfdaş üçün ƏN ÇOX İKİ söhbət sətri olur: "şəxsi" və "iş".
// `isBusiness` açıq işarədir; köhnə mesajlarda o sahə yoxdur, ona görə kontekst
// (məhsul/obyekt) da eyni nəticəni verir.
type Segment = 'BUSINESS' | 'PERSONAL';
const segOf = (m: { listingId?: number | null; businessObjectId?: number | null; isBusiness?: boolean }): Segment =>
  m.isBusiness || m.businessObjectId || m.listingId ? 'BUSINESS' : 'PERSONAL';

// Seçilmiş seqment üçün Prisma filtri. Seqment verilməyibsə boş obyekt qayıdır
// (köhnə çağırışlar — məs. dərin link — bütün mesajları görməyə davam edir).
function segWhere(seg?: unknown): any {
  const s = String(seg || '').toUpperCase();
  if (s === 'BUSINESS') return { OR: [{ isBusiness: true }, { businessObjectId: { not: null } }, { listingId: { not: null } }] };
  if (s === 'PERSONAL') return { isBusiness: false, businessObjectId: null, listingId: null };
  return {};
}

// İŞ seqmentində yazılan CAVABIN konteksti.
//
// Alıcı məhsul səhifəsindən yazanda mesaja listingId düşür — satıcının cavabında
// isə heç nə olmur. Kontekst bərpa edilməsə cavab şəxsi söhbətə düşərdi və iki
// axın yenidən qarışardı. Ona görə həmin iki şəxs arasındakı SON iş mesajının
// konteksti təkrarlanır.
//
// DİQQƏT: müştəridən gələn obyekt id-sinə etibar etmirik — uydurulub başqasının
// obyektinə mesaj bağlana bilərdi. Kontekst yalnız BAZADAKI keçmişdən götürülür.
async function businessCtx(userId: number, partnerId: number): Promise<{ listingId: number | null; businessObjectId: number | null }> {
  const last = await prisma.message.findFirst({
    where: {
      conversationId: null,
      OR: [{ senderId: userId, receiverId: partnerId }, { senderId: partnerId, receiverId: userId }],
      AND: [{ OR: [{ businessObjectId: { not: null } }, { listingId: { not: null } }] }],
    },
    orderBy: { id: 'desc' },
    select: { listingId: true, businessObjectId: true },
  });
  return { listingId: last?.listingId ?? null, businessObjectId: last?.businessObjectId ?? null };
}

// Media/kontakt/konum mesajları üçün seqment sahələri (mətn yolundan ayrı).
// `isBusiness` həmişə yazılır — kontekst tapılmasa belə mesaj öz axınında qalır.
async function segFields(senderId: number, receiver: number, body: any) {
  if (String(body?.segment || '').toUpperCase() !== 'BUSINESS') return {};
  return { isBusiness: true, ...(await businessCtx(senderId, receiver)) };
}

// Qrupun bütün üzv id-ləri.
async function conversationMemberIds(conversationId: number): Promise<number[]> {
  const mems = await prisma.conversationMember.findMany({ where: { conversationId }, select: { userId: true } });
  return mems.map((m) => m.userId);
}

// Bir mesajı görməli olan istifadəçilər (1:1 → iki tərəf, qrup → bütün üzvlər).
async function messageRecipients(m: { senderId: number; receiverId: number | null; conversationId: number | null }): Promise<number[]> {
  if (m.conversationId) return conversationMemberIds(m.conversationId);
  return [m.senderId, m.receiverId!].filter((x) => !!x) as number[];
}

// Mesaj yarat + aidiyyəti tərəflərə real-time göndər (1:1 və ya qrup).
async function createAndEmit(senderId: number, target: { receiver?: number; conversationId?: number }, data: any, res: Response) {
  const isGroup = !!target.conversationId;
  const online = !isGroup && target.receiver ? isUserOnline(target.receiver) : false;
  const message = await prisma.message.create({
    data: {
      senderId,
      receiverId: isGroup ? null : target.receiver!,
      conversationId: target.conversationId || null,
      deliveredAt: online ? new Date() : null,
      ...data,
    },
    include: msgInclude,
  });
  if (isGroup) {
    const ids = await conversationMemberIds(target.conversationId!);
    ids.forEach((id) => emitToUser(id, 'chat:message', message));
  } else {
    emitToUser(target.receiver!, 'chat:message', message);
    emitToUser(senderId, 'chat:message', message);
    if (online) emitToUser(senderId, 'chat:delivered', { ids: [message.id], deliveredAt: message.deliveredAt });
  }
  res.status(201).json({ success: true, message });
}

// İstifadəçinin qrup üzvü olduğunu yoxla.
async function assertMember(conversationId: number, userId: number): Promise<boolean> {
  const m = await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId, userId } } });
  return !!m;
}

// Send message (mətn) — 1:1 və ya qrup (conversationId verilərsə).
router.post('/messages', messageLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { receiverId, listingId, consultationId, content, replyToId } = req.body;
    if (!content?.trim()) {
      res.status(400).json({ success: false, message: 'Mesaj boş ola bilməz' });
      return;
    }

    // Qrup mesajı
    const conversationId = req.body.conversationId ? parseInt(String(req.body.conversationId)) : 0;
    if (conversationId) {
      if (!(await assertMember(conversationId, req.adminId!))) { res.status(403).json({ success: false, message: 'Bu qrupun üzvü deyilsiniz' }); return; }
      await createAndEmit(req.adminId!, { conversationId }, { content: content.trim(), replyToId: replyToId ? parseInt(String(replyToId)) : null }, res);
      return;
    }

    // Rəy konsultasiyası mesajı — yalnız seans AKTİV və vaxtı varsa göndərilə bilər.
    let consultId: number | null = null;
    if (consultationId) {
      consultId = parseInt(String(consultationId));
      const s = await prisma.consultationSession.findUnique({ where: { id: consultId } });
      if (!s || (s.buyerId !== req.adminId && s.professionalId !== req.adminId)) {
        res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return;
      }
      const used = s.consumedSeconds + (s.status === 'ACTIVE' && s.runningSince ? Math.floor((Date.now() - new Date(s.runningSince).getTime()) / 1000) : 0);
      const remaining = s.durationSeconds - used;
      if (s.status !== 'ACTIVE' || remaining <= 0) {
        res.status(403).json({ success: false, message: 'Konsultasiya aktiv deyil — vaxt bitib və ya başlanmayıb' }); return;
      }
    }

    let receiver = parseInt(receiverId);
    // Mesajın hansı obyektə/məhsula aid olduğu — seqmenti də bu təyin edir.
    let msgObjectId: number | null = null;
    let msgListingId: number | null = listingId ? parseInt(String(listingId)) : null;
    const msgIsBusiness = !!msgListingId || String(req.body.segment || '').toUpperCase() === 'BUSINESS';
    // VÖEN (obyekt) elanına yazılan mesaj — elanı paylaşana yox, obyektin əlaqə
    // nömrəsinin sahibinə yönləndirilir. Obyektin telefonu bir istifadəçiyə aiddirsə
    // ona, deyilsə biznes sahibinə gedir. (Satıcı alıcıya cavab yazanda dəyişmir.)
    if (listingId) {
      const L = await prisma.listing.findUnique({
        where: { id: parseInt(String(listingId)) },
        select: {
          userId: true, businessObjectId: true,
          businessObject: { select: { phone: true, business: { select: { userId: true } } } },
        },
      });
      msgObjectId = L?.businessObjectId ?? null;
      if (L?.businessObjectId && receiver === L.userId) {
        let objContact: number | null = null;
        // Telefonu SON 9 RƏQƏM üzrə uyğunlaşdırırıq. Hərfi mətn müqayisəsi
        // səssizcə sınırdı: istifadəçi "+994501234567" kimi qeydiyyatdan keçir,
        // obyekt nömrəsi isə əl ilə "050 123 45 67" yazıla bilər — format
        // fərqli olduğu üçün uyğunluq tapılmır və mesaj yanlış şəxsə (biznes
        // sahibinə) gedirdi. Nə göndərən, nə alan bunu görürdü.
        // (Eyni normallaşdırma kontaktlarda da işlədilir.)
        const objDigits = (L.businessObject?.phone || '').replace(/\D/g, '');
        const tail9 = objDigits.slice(-9);
        if (tail9.length >= 7) {
          const rows = await prisma.$queryRaw<{ id: number }[]>(
            Prisma.sql`SELECT id FROM "User"
                       WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) = ${tail9}
                         AND "isBlocked" = false
                       LIMIT 1`,
          );
          if (rows.length) objContact = rows[0].id;
        }
        if (!objContact) objContact = L.businessObject?.business?.userId ?? null;
        if (objContact && objContact !== req.adminId) receiver = objContact;
      }
    } else if (String(req.body.segment || '').toUpperCase() === 'BUSINESS') {
      // "İş" sekmesində yazılan cavab — kontekst keçmişdən bərpa olunur ki,
      // mesaj öz sekmesində qalsın, şəxsi söhbətə düşməsin.
      const ctx = await businessCtx(req.adminId!, receiver);
      msgObjectId = ctx.businessObjectId;
      msgListingId = ctx.listingId;
    }
    // Blok — hər hansı tərəf digərini bloklayıbsa mesaj göndərilə bilməz.
    const blk = await prisma.blockedUser.findFirst({ where: { OR: [{ blockerId: receiver, blockedId: req.adminId! }, { blockerId: req.adminId!, blockedId: receiver }] }, select: { blockerId: true } });
    if (blk) { res.status(403).json({ success: false, message: blk.blockerId === receiver ? 'Bu istifadəçi sizi bloklayıb' : 'Bu istifadəçini bloklamısınız — blokdan çıxarın' }); return; }
    const online = isUserOnline(receiver);
    const message = await prisma.message.create({
      data: {
        senderId: req.adminId!,
        receiverId: receiver,
        listingId: msgListingId,
        businessObjectId: msgObjectId,
        isBusiness: msgIsBusiness,
        consultationId: consultId,
        content: content.trim(),
        replyToId: replyToId ? parseInt(String(replyToId)) : null,
        deliveredAt: online ? new Date() : null,
      },
      include: msgInclude,
    });

    emitToUser(receiver, 'chat:message', message);
    emitToUser(req.adminId!, 'chat:message', message);
    if (online) emitToUser(req.adminId!, 'chat:delivered', { ids: [message.id], deliveredAt: message.deliveredAt });

    res.status(201).json({ success: true, message });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Zəng qeydi — səsli/görüntülü zəng bitəndə zəng EDƏN tərəf yazır (bir dəfə).
// Chat-də mesaj kimi görünür; hər iki tərəf görür. status: ANSWERED | MISSED.
router.post('/messages/call', messageLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const to = parseInt(String(req.body.to));
    const kind = req.body.kind === 'video' ? 'video' : 'audio';
    const status = req.body.status === 'ANSWERED' ? 'ANSWERED' : 'MISSED';
    const duration = Math.max(0, Math.min(24 * 3600, parseInt(String(req.body.duration)) || 0));
    if (!to || to === req.adminId) { res.status(400).json({ success: false, message: 'Yanlış alıcı' }); return; }

    const online = isUserOnline(to);
    const message = await prisma.message.create({
      data: {
        senderId: req.adminId!,
        receiverId: to,
        type: 'CALL',
        callKind: kind,
        callStatus: status,
        mediaDuration: status === 'ANSWERED' ? duration : null,
        content: '',
        deliveredAt: online ? new Date() : null,
      },
      include: msgInclude,
    });

    emitToUser(to, 'chat:message', message);
    emitToUser(req.adminId!, 'chat:message', message);
    res.status(201).json({ success: true, message });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Redaktə et — yalnız göndərən, silinməmiş mesaj.
router.patch('/messages/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const { content } = req.body;
    if (!content?.trim()) { res.status(400).json({ success: false, message: 'Mesaj boş ola bilməz' }); return; }
    const m = await prisma.message.findUnique({ where: { id } });
    if (!m || m.senderId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    if (m.deletedAt) { res.status(400).json({ success: false, message: 'Silinmiş mesaj redaktə olunmur' }); return; }
    const updated = await prisma.message.update({ where: { id }, data: { content: content.trim(), editedAt: new Date() }, include: msgInclude });
    (await messageRecipients(m)).forEach((uid) => emitToUser(uid, 'chat:updated', updated));
    res.json({ success: true, message: updated });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Hamı üçün sil — sətir qalır, mətn boşalır, reaksiyalar silinir.
router.delete('/messages/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const m = await prisma.message.findUnique({ where: { id } });
    if (!m || m.senderId !== req.adminId) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    await prisma.messageReaction.deleteMany({ where: { messageId: id } });
    const updated = await prisma.message.update({ where: { id }, data: { deletedAt: new Date(), content: '' }, include: msgInclude });
    (await messageRecipients(m)).forEach((uid) => emitToUser(uid, 'chat:deleted', { id, deletedAt: updated.deletedAt }));
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Yalnız məndə sil — mesaj yalnız bu istifadəçidə gizlədilir (WhatsApp "mənim üçün sil").
router.post('/messages/:id/hide', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const userId = req.adminId!;
    const m = await prisma.message.findUnique({ where: { id }, select: { id: true, senderId: true, receiverId: true, conversationId: true } });
    if (!m) { res.status(404).json({ success: false, message: 'Mesaj tapılmadı' }); return; }
    // İstifadəçi bu söhbətin iştirakçısı olmalıdır.
    const participant = m.senderId === userId || m.receiverId === userId ||
      (m.conversationId ? !!(await prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: m.conversationId, userId } } })) : false);
    if (!participant) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    await prisma.message.updateMany({ where: { id, NOT: { deletedForIds: { has: userId } } }, data: { deletedForIds: { push: userId } } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Söhbəti məndə sil (1:1) — bu şəxslə bütün mesajlar yalnız məndə gizlədilir; söhbət siyahıdan çıxır.
router.delete('/messages/thread/:partnerId', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.adminId!;
    const partnerId = parseInt(String(req.params.partnerId));
    // Seqment verilibsə yalnız həmin axın silinir — "iş" söhbətini silmək
    // eyni şəxslə şəxsi yazışmanı silməməlidir.
    await prisma.message.updateMany({
      where: {
        conversationId: null,
        AND: [
          { OR: [{ senderId: userId, receiverId: partnerId }, { senderId: partnerId, receiverId: userId }] },
          segWhere(req.query.segment),
        ],
        NOT: { deletedForIds: { has: userId } },
      },
      data: { deletedForIds: { push: userId } },
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Qrup söhbətini məndə sil — qrupun bütün mesajları yalnız məndə gizlədilir.
router.delete('/messages/group/:conversationId', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.adminId!;
    const conversationId = parseInt(String(req.params.conversationId));
    await prisma.message.updateMany({
      where: { conversationId, NOT: { deletedForIds: { has: userId } } },
      data: { deletedForIds: { push: userId } },
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Emoji reaksiya — toggle.
router.post('/messages/:id/react', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const emoji = String(req.body?.emoji || '').slice(0, 8);
    if (!emoji) { res.status(400).json({ success: false, message: 'Emoji tələb olunur' }); return; }
    const m = await prisma.message.findUnique({ where: { id }, select: { id: true, senderId: true, receiverId: true, conversationId: true, deletedAt: true } });
    if (!m) { res.status(404).json({ success: false, message: 'Mesaj tapılmadı' }); return; }
    if (m.deletedAt) { res.status(400).json({ success: false, message: 'Silinmiş mesaja reaksiya olmaz' }); return; }
    const me = req.adminId!;
    const recipients = await messageRecipients(m);
    if (!recipients.includes(me)) { res.status(403).json({ success: false, message: 'İcazə yoxdur' }); return; }
    const existing = await prisma.messageReaction.findUnique({ where: { messageId_userId: { messageId: id, userId: me } } });
    if (existing && existing.emoji === emoji) {
      await prisma.messageReaction.delete({ where: { id: existing.id } });
    } else if (existing) {
      await prisma.messageReaction.update({ where: { id: existing.id }, data: { emoji } });
    } else {
      await prisma.messageReaction.create({ data: { messageId: id, userId: me, emoji } });
    }
    const reactions = await prisma.messageReaction.findMany({ where: { messageId: id }, select: { userId: true, emoji: true } });
    recipients.forEach((uid) => emitToUser(uid, 'chat:reaction', { id, reactions }));
    res.json({ success: true, reactions });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Media mesajı (şəkil / fayl / səs / video) — 1:1 və ya qrup.
router.post('/messages/media', messageLimiter, adminAuth, chatUpload.single('media'), async (req: AuthRequest, res: Response) => {
  try {
    const file = (req as any).file;
    if (!file) { res.status(400).json({ success: false, message: 'Fayl tələb olunur' }); return; }
    const mime: string = file.mimetype || '';
    let type: any = String(req.body.type || '').toUpperCase();
    if (!['IMAGE', 'FILE', 'AUDIO', 'VIDEO'].includes(type)) {
      type = mime.startsWith('image/') ? 'IMAGE' : mime.startsWith('audio/') ? 'AUDIO' : mime.startsWith('video/') ? 'VIDEO' : 'FILE';
    }
    const duration = req.body.duration ? parseInt(String(req.body.duration)) : 0;
    const data = {
      content: (req.body.caption || '').trim(),
      type,
      mediaUrl: file.filename,
      mediaName: file.originalname,
      mediaMime: mime,
      mediaSize: file.size,
      mediaDuration: duration > 0 ? duration : null,
      replyToId: req.body.replyToId ? parseInt(String(req.body.replyToId)) : null,
    };
    const conversationId = req.body.conversationId ? parseInt(String(req.body.conversationId)) : 0;
    if (conversationId) {
      if (!(await assertMember(conversationId, req.adminId!))) { res.status(403).json({ success: false, message: 'Bu qrupun üzvü deyilsiniz' }); return; }
      await createAndEmit(req.adminId!, { conversationId }, data, res);
      return;
    }
    const receiver = parseInt(String(req.body.receiverId));
    if (!receiver) { res.status(400).json({ success: false, message: 'Alıcı yoxdur' }); return; }
    // "İş" sekmesindən göndərilirsə obyekt/məhsul konteksti də yazılsın.
    await createAndEmit(req.adminId!, { receiver }, { ...data, ...(await segFields(req.adminId!, receiver, req.body)) }, res);
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Kontakt paylaş — 1:1 və ya qrup.
router.post('/messages/contact', messageLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const contactName = String(req.body.contactName || '').trim();
    const contactPhone = String(req.body.contactPhone || '').trim();
    if (!contactName || !contactPhone) { res.status(400).json({ success: false, message: 'Kontakt məlumatı natamam' }); return; }
    const data = {
      content: '',
      type: 'CONTACT' as any,
      mediaName: contactName,
      contactPhone,
      contactUserId: req.body.contactUserId ? parseInt(String(req.body.contactUserId)) : null,
      replyToId: req.body.replyToId ? parseInt(String(req.body.replyToId)) : null,
    };
    const conversationId = req.body.conversationId ? parseInt(String(req.body.conversationId)) : 0;
    if (conversationId) {
      if (!(await assertMember(conversationId, req.adminId!))) { res.status(403).json({ success: false, message: 'Bu qrupun üzvü deyilsiniz' }); return; }
      await createAndEmit(req.adminId!, { conversationId }, data, res);
      return;
    }
    const receiver = parseInt(String(req.body.receiverId));
    if (!receiver) { res.status(400).json({ success: false, message: 'Alıcı yoxdur' }); return; }
    // "İş" sekmesindən göndərilirsə obyekt/məhsul konteksti də yazılsın.
    await createAndEmit(req.adminId!, { receiver }, { ...data, ...(await segFields(req.adminId!, receiver, req.body)) }, res);
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Konum paylaş — 1:1 və ya qrup. latitude/longitude tələb olunur.
router.post('/messages/location', messageLimiter, adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const latitude = parseFloat(String(req.body.latitude));
    const longitude = parseFloat(String(req.body.longitude));
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      res.status(400).json({ success: false, message: 'Konum məlumatı yanlışdır' }); return;
    }
    const data = {
      content: String(req.body.address || '').trim(), // istəyə bağlı ünvan mətni
      type: 'LOCATION' as any,
      latitude,
      longitude,
      replyToId: req.body.replyToId ? parseInt(String(req.body.replyToId)) : null,
    };
    const conversationId = req.body.conversationId ? parseInt(String(req.body.conversationId)) : 0;
    if (conversationId) {
      if (!(await assertMember(conversationId, req.adminId!))) { res.status(403).json({ success: false, message: 'Bu qrupun üzvü deyilsiniz' }); return; }
      await createAndEmit(req.adminId!, { conversationId }, data, res);
      return;
    }
    const receiver = parseInt(String(req.body.receiverId));
    if (!receiver) { res.status(400).json({ success: false, message: 'Alıcı yoxdur' }); return; }
    // "İş" sekmesindən göndərilirsə obyekt/məhsul konteksti də yazılsın.
    await createAndEmit(req.adminId!, { receiver }, { ...data, ...(await segFields(req.adminId!, receiver, req.body)) }, res);
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get my conversations (1:1 only — qrup mesajları xaric)
router.get('/messages/conversations', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.adminId!;

    const messages = await prisma.message.findMany({
      where: { conversationId: null, OR: [{ senderId: userId }, { receiverId: userId }], NOT: { deletedForIds: { has: userId } } },
      include: {
        sender: { select: { id: true, name: true, type: true, avatar: true } },
        receiver: { select: { id: true, name: true, type: true, avatar: true } },
        listing: { select: { id: true, title: true } },
        businessObject: { select: { id: true, name: true, city: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Söhbətlər HƏM tərəfdaşa, HƏM DƏ seqmentə görə qruplaşır: eyni şəxslə
    // "şəxsi" və "iş" söhbəti ayrı sətirlərdir. Mesajlar tarixə görə azalan
    // sıradadır, ona görə hər açarın ilk mesajı = son mesaj.
    const convMap = new Map<string, any>();
    for (const msg of messages) {
      const partnerId = (msg.senderId === userId ? msg.receiverId : msg.senderId) as number;
      if (!partnerId) continue;
      const partner = msg.senderId === userId ? msg.receiver : msg.sender;
      const segment = segOf(msg);
      const key = `${partnerId}:${segment}`;
      let c = convMap.get(key);
      if (!c) {
        c = { key, segment, partner, lastMessage: msg, unreadCount: 0, businessObject: null, listing: null };
        convMap.set(key, c);
      }
      if (msg.senderId === partnerId && msg.receiverId === userId && !msg.read) c.unreadCount++;
      // Söhbətin başlığında hansı obyektə/məhsula aid olduğu görünsün. Son mesaj
      // sadə cavab ola bilər — ona görə seqmentdəki ƏN SON dolu kontekst tutulur.
      if (segment === 'BUSINESS') {
        if (!c.businessObject && msg.businessObject) c.businessObject = msg.businessObject;
        if (!c.listing && msg.listing) c.listing = msg.listing;
      }
    }

    res.json({ conversations: Array.from(convMap.values()) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get messages with a specific user (1:1, pagination)
router.get('/messages/:partnerId', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.adminId!;
    const partnerId = parseInt(String(req.params.partnerId));
    const limit = parseInt(req.query.limit as string) || 50;
    const before = req.query.before ? parseInt(req.query.before as string) : undefined;

    // Seqment (şəxsi / iş) verilibsə yalnız həmin axın göstərilir. Verilməyibsə
    // bütün mesajlar gəlir — köhnə dərin linklər işləməyə davam etsin.
    const segment = String(req.query.segment || '').toUpperCase();
    const seg = segWhere(segment);
    const base: any = {
      conversationId: null,
      AND: [
        { OR: [{ senderId: userId, receiverId: partnerId }, { senderId: partnerId, receiverId: userId }] },
        seg,
      ],
      NOT: { deletedForIds: { has: userId } }, // "məndə sil" ilə gizlədilənlər görünmür
    };
    const where: any = { ...base };
    if (before) where.id = { lt: before };

    const total = await prisma.message.count({ where: base });
    const messages = await prisma.message.findMany({ where, include: msgInclude, orderBy: { createdAt: 'desc' }, take: limit });
    messages.reverse();

    // Oxundu işarəsi də seqmentə bağlıdır — "şəxsi"yə baxmaq "iş" mesajlarını
    // oxunmuş etməməlidir, əks halda satıcı gələn sifariş mesajını itirər.
    const upd = await prisma.message.updateMany({
      where: { senderId: partnerId, receiverId: userId, read: false, AND: [seg] },
      data: { read: true },
    });
    if (upd.count > 0) emitToUser(partnerId, 'chat:read', { by: userId });

    const partner = await prisma.user.findUnique({ where: { id: partnerId }, select: { id: true, name: true, phone: true, type: true, avatar: true } });
    res.json({ messages, partner, segment: segment || null, total, hasMore: total > (before ? messages.length : limit) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Get unread count (1:1)
router.get('/messages-unread', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const count = await prisma.message.count({ where: { conversationId: null, receiverId: req.adminId!, read: false } });
    res.json({ count });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ── Blok ──────────────────────────────────────────────────────────────────
// Bloklanmış istifadəçilərimin id-ləri.
router.get('/me/blocked', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const rows = await prisma.blockedUser.findMany({ where: { blockerId: req.adminId! }, select: { blockedId: true } });
    res.json({ success: true, blocked: rows.map((r) => r.blockedId) });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});
// İstifadəçini blokla.
router.post('/me/block/:userId', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const uid = parseInt(String(req.params.userId));
    if (Number.isNaN(uid) || uid === req.adminId) { res.status(400).json({ success: false, message: 'Yanlış istifadəçi' }); return; }
    await prisma.blockedUser.upsert({ where: { blockerId_blockedId: { blockerId: req.adminId!, blockedId: uid } }, create: { blockerId: req.adminId!, blockedId: uid }, update: {} });
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});
// Blokdan çıxar.
router.delete('/me/block/:userId', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const uid = parseInt(String(req.params.userId));
    await prisma.blockedUser.deleteMany({ where: { blockerId: req.adminId!, blockedId: uid } });
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ success: false, message: e.message }); }
});

export default router;
