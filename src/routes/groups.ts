import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { adminAuth, AuthRequest } from '../middleware/auth';
import { emitToUser } from '../services/callSignaling';
import { leaveProGroup, syncProGroups } from '../services/proGroups';
import { verifiedProfessions } from '../services/professionDiscount';

const router = Router();
const prisma = new PrismaClient();

const msgInclude = {
  sender: { select: { id: true, name: true, avatar: true } },
  reactions: { select: { userId: true, emoji: true } },
  replyTo: { select: { id: true, content: true, senderId: true, deletedAt: true, type: true, mediaName: true } },
} as const;

async function memberIds(conversationId: number): Promise<number[]> {
  const mems = await prisma.conversationMember.findMany({ where: { conversationId }, select: { userId: true } });
  return mems.map((m) => m.userId);
}
async function getMember(conversationId: number, userId: number) {
  return prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId, userId } } });
}
function notify(ids: number[], conversationId: number) {
  ids.forEach((id) => emitToUser(id, 'chat:groupChanged', { conversationId }));
}

const isProGroup = async (id: number) => (await prisma.conversation.findUnique({ where: { id }, select: { kind: true } }))?.kind === 'PRO_CITY';

// Qrupu üzv istifadəçi məlumatları ilə formala.
// Peşə qrupunda üzvlər bir-birini tanımır — telefon nömrələri GİZLİDİR; ixtisası
// sənədlə təsdiqli olanlar «verified» işarəsi alır.
async function shapeGroup(conversationId: number) {
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { members: true } });
  if (!conv) return null;
  const pro = conv.kind === 'PRO_CITY';
  const users = await prisma.user.findMany({ where: { id: { in: conv.members.map((m) => m.userId) } }, select: { id: true, name: true, avatar: true, type: true, phone: true } });
  const umap = new Map(users.map((u) => [u.id, pro ? { ...u, phone: null } : u]));
  const verified = new Set<number>();
  if (pro && conv.professionKey) {
    for (const m of conv.members.slice(0, 300)) if ((await verifiedProfessions(m.userId)).has(conv.professionKey)) verified.add(m.userId);
  }
  return {
    id: conv.id,
    name: conv.name,
    avatar: conv.avatar,
    createdById: conv.createdById,
    kind: conv.kind, city: conv.city, profession: conv.profession,
    members: conv.members.map((m) => ({ userId: m.userId, role: pro ? 'MEMBER' : m.role, user: umap.get(m.userId) || null, verifiedProfession: verified.has(m.userId) })),
  };
}

// Qrup yarat.
router.post('/groups', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) { res.status(400).json({ success: false, message: 'Qrup adı tələb olunur' }); return; }
    const raw: any[] = Array.isArray(req.body?.memberIds) ? req.body.memberIds : [];
    const ids = Array.from(new Set([req.adminId!, ...raw.map((x) => parseInt(String(x))).filter((n) => n > 0)]));
    const conv = await prisma.conversation.create({
      data: {
        name,
        createdById: req.adminId!,
        members: { create: ids.map((uid) => ({ userId: uid, role: uid === req.adminId! ? 'ADMIN' : 'MEMBER' })) },
      },
    });
    notify(ids, conv.id);
    res.status(201).json({ success: true, group: await shapeGroup(conv.id) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Mənim qruplarım (son mesaj + oxunmamış say).
router.get('/groups', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const me = req.adminId!;
    // Köhnə istifadəçi ilk dəfə — peşə qrupuna bir dəfəlik avtomatik qoşulma.
    await syncProGroups(me, 'PASSIVE').catch(() => {});
    const memberships = await prisma.conversationMember.findMany({
      where: { userId: me },
      include: { conversation: true },
    });
    const groups = await Promise.all(memberships.map(async (mm) => {
      const cid = mm.conversationId;
      const lastMessage = await prisma.message.findFirst({ where: { conversationId: cid, NOT: { deletedForIds: { has: me } } }, orderBy: { createdAt: 'desc' }, include: { sender: { select: { id: true, name: true } } } });
      const unreadCount = await prisma.message.count({
        where: { conversationId: cid, senderId: { not: me }, NOT: { deletedForIds: { has: me } }, ...(mm.lastReadAt ? { createdAt: { gt: mm.lastReadAt } } : {}) },
      });
      const memberCount = await prisma.conversationMember.count({ where: { conversationId: cid } });
      return {
        id: cid,
        isGroup: true,
        name: mm.conversation.name,
        avatar: mm.conversation.avatar,
        kind: mm.conversation.kind,
        memberCount,
        lastMessage,
        unreadCount,
        lastAt: lastMessage?.createdAt || mm.conversation.createdAt,
      };
    }));
    groups.sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime());
    res.json({ groups });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Qrup məlumatı + üzvlər.
router.get('/groups/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    if (!(await getMember(id, req.adminId!))) { res.status(403).json({ success: false, message: 'Bu qrupun üzvü deyilsiniz' }); return; }
    const group = await shapeGroup(id);
    if (!group) { res.status(404).json({ success: false, message: 'Qrup tapılmadı' }); return; }
    res.json({ success: true, group });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Qrup mesajları (səhifələmə) + lastReadAt yenilə.
router.get('/groups/:id/messages', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    if (!(await getMember(id, req.adminId!))) { res.status(403).json({ success: false, message: 'Bu qrupun üzvü deyilsiniz' }); return; }
    const limit = parseInt(req.query.limit as string) || 50;
    const before = req.query.before ? parseInt(req.query.before as string) : undefined;
    const where: any = { conversationId: id, NOT: { deletedForIds: { has: req.adminId! } } };
    if (before) where.id = { lt: before };
    const total = await prisma.message.count({ where: { conversationId: id, NOT: { deletedForIds: { has: req.adminId! } } } });
    const messages = await prisma.message.findMany({ where, include: msgInclude, orderBy: { createdAt: 'desc' }, take: limit });
    messages.reverse();
    await prisma.conversationMember.update({ where: { conversationId_userId: { conversationId: id, userId: req.adminId! } }, data: { lastReadAt: new Date() } });
    res.json({ messages, total, hasMore: total > (before ? messages.length : limit) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Üzv əlavə et (yalnız admin).
router.post('/groups/:id/members', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    if (await isProGroup(id)) { res.status(403).json({ success: false, message: 'Peşə qrupuna üzv əlavə edilmir — hər kəs öz ixtisası və şəhəri ilə özü qoşulur' }); return; }
    const me = await getMember(id, req.adminId!);
    if (!me || me.role !== 'ADMIN') { res.status(403).json({ success: false, message: 'Yalnız qrup admini üzv əlavə edə bilər' }); return; }
    const raw: any[] = Array.isArray(req.body?.memberIds) ? req.body.memberIds : [];
    const add = Array.from(new Set(raw.map((x) => parseInt(String(x))).filter((n) => n > 0)));
    for (const uid of add) {
      await prisma.conversationMember.upsert({
        where: { conversationId_userId: { conversationId: id, userId: uid } },
        create: { conversationId: id, userId: uid, role: 'MEMBER' },
        update: {},
      });
    }
    notify(await memberIds(id), id);
    res.json({ success: true, group: await shapeGroup(id) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Üzv çıxar (admin) və ya qrupdan çıx (özün).
router.delete('/groups/:id/members/:userId', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const targetId = parseInt(String(req.params.userId));
    const me = await getMember(id, req.adminId!);
    if (!me) { res.status(403).json({ success: false, message: 'Bu qrupun üzvü deyilsiniz' }); return; }
    const isSelf = targetId === req.adminId!;
    if (await isProGroup(id)) {
      // Peşə qrupunda yalnız özün çıxa bilərsən (opt-out yazılır ki, geri avtomatik əlavə olunmayasan).
      if (!isSelf) { res.status(403).json({ success: false, message: 'Peşə qrupunda başqasını çıxarmaq olmur' }); return; }
      await leaveProGroup(req.adminId!, id);
      res.json({ success: true }); return;
    }
    if (!isSelf && me.role !== 'ADMIN') { res.status(403).json({ success: false, message: 'Yalnız admin üzv çıxara bilər' }); return; }
    const before = await memberIds(id);
    await prisma.conversationMember.deleteMany({ where: { conversationId: id, userId: targetId } });
    notify(before, id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Üzvə səlahiyyət ver / al — admin başqa üzvü admin edir və ya adminliyini alır.
router.patch('/groups/:id/members/:userId', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    const targetId = parseInt(String(req.params.userId));
    if (await isProGroup(id)) { res.status(403).json({ success: false, message: 'Peşə qrupunda admin yoxdur' }); return; }
    const me = await getMember(id, req.adminId!);
    if (!me || me.role !== 'ADMIN') { res.status(403).json({ success: false, message: 'Yalnız admin səlahiyyət dəyişə bilər' }); return; }
    const role = String(req.body?.role || '').toUpperCase() === 'ADMIN' ? 'ADMIN' : 'MEMBER';
    const target = await getMember(id, targetId);
    if (!target) { res.status(404).json({ success: false, message: 'Üzv tapılmadı' }); return; }
    // Son admini adi üzvə salmağa icazə vermə (qrup adminsiz qalmasın).
    if (role === 'MEMBER' && target.role === 'ADMIN') {
      const admins = await prisma.conversationMember.count({ where: { conversationId: id, role: 'ADMIN' } });
      if (admins <= 1) { res.status(400).json({ success: false, message: 'Qrupda ən azı bir admin qalmalıdır' }); return; }
    }
    await prisma.conversationMember.update({ where: { conversationId_userId: { conversationId: id, userId: targetId } }, data: { role } });
    notify(await memberIds(id), id);
    res.json({ success: true, group: await shapeGroup(id) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Qrup adını dəyiş (admin).
router.patch('/groups/:id', adminAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseInt(String(req.params.id));
    if (await isProGroup(id)) { res.status(403).json({ success: false, message: 'Peşə qrupunun adı şəhər və ixtisasdan gəlir — dəyişdirilmir' }); return; }
    const me = await getMember(id, req.adminId!);
    if (!me || me.role !== 'ADMIN') { res.status(403).json({ success: false, message: 'Yalnız admin dəyişə bilər' }); return; }
    const name = String(req.body?.name || '').trim();
    if (!name) { res.status(400).json({ success: false, message: 'Ad boş ola bilməz' }); return; }
    await prisma.conversation.update({ where: { id }, data: { name } });
    notify(await memberIds(id), id);
    res.json({ success: true, group: await shapeGroup(id) });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
