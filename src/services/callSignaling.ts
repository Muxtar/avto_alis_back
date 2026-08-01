// Səsli/görüntülü zəng üçün WebRTC signaling — socket.io üzərində.
// Railway WebSocket-i dəstəkləyir; media P2P (WebRTC) gedir, server yalnız
// siqnalları (offer/answer/ICE) ötürür — serverə media yükü düşmür.
//
// ICE: Google STUN pulsuz. Bəzi şəbəkələr (CGNAT/simmetrik NAT) üçün TURN
// lazım ola bilər — env ilə əlavə olunur: TURN_URL, TURN_USERNAME, TURN_CREDENTIAL.
import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { verifyTokenUserId } from '../middleware/auth';

const prisma = new PrismaClient();

// Qrup zəngi iştirakçıları — conversationId -> aktiv userId dəsti (yaddaşda).
const groupCalls = new Map<number, Set<number>>();
// Aktiv qrup zənginin növü (audio/video) + tarixçə mesaj id-si — conversationId üzrə.
const groupCallKind = new Map<number, 'audio' | 'video'>();
const groupCallMsg = new Map<number, number>();
// Bir qrup zəngində maksimum iştirakçı sayı (mesh WebRTC kiçik qruplar üçün).
const MAX_GROUP_CALL = 5;
async function groupMemberIds(conversationId: number): Promise<number[]> {
  const mems = await prisma.conversationMember.findMany({ where: { conversationId }, select: { userId: true } });
  return mems.map((m) => m.userId);
}
// Qrupun bütün üzvlərinə aktiv zəng vəziyyətini bildir (qrupu açan hər kəs "Qoşul" görsün).
async function broadcastGroupCallState(cid: number) {
  if (!ioRef) return;
  const set = groupCalls.get(cid);
  const ids = set ? Array.from(set) : [];
  const kind = groupCallKind.get(cid) || 'audio';
  const participants = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, avatar: true } }) : [];
  const members = await groupMemberIds(cid);
  const payload = { conversationId: cid, active: ids.length > 0, count: ids.length, kind, participants };
  members.forEach((m) => ioRef!.to(`u:${m}`).emit('groupcall:state', payload));
}

// Routes-dan real-time push üçün ortaq io referansı (çat mesajları, oxundu və s.).
let ioRef: Server | null = null;
export function emitToUser(userId: number, event: string, payload: any) {
  ioRef?.to(`u:${userId}`).emit(event, payload);
}
export function isUserOnline(userId: number): boolean {
  const room = ioRef?.sockets.adapter.rooms.get(`u:${userId}`);
  return !!room && room.size > 0;
}

// Bu istifadəçi ilə 1:1 yazışan tərəflərin id-ləri — presence dəyişimini
// yalnız onlara yayımlayırıq (hamıya yox — həm privacy, həm yük).
async function chatPartnerIds(userId: number): Promise<number[]> {
  const msgs = await prisma.message.findMany({
    where: { OR: [{ senderId: userId }, { receiverId: userId }], receiverId: { not: null } },
    select: { senderId: true, receiverId: true },
    take: 3000,
  });
  const set = new Set<number>();
  for (const m of msgs) {
    if (m.senderId !== userId) set.add(m.senderId);
    if (m.receiverId && m.receiverId !== userId) set.add(m.receiverId);
  }
  return Array.from(set);
}

// Bir istifadəçinin online/offline vəziyyətini yazışdığı tərəflərə göndər.
async function broadcastPresence(userId: number, online: boolean, lastSeen?: Date) {
  const payload = { userId, online, lastSeen: lastSeen ? lastSeen.toISOString() : null };
  const partners = await chatPartnerIds(userId);
  for (const pid of partners) ioRef?.to(`u:${pid}`).emit('presence:update', payload);
}

function iceServers() {
  const servers: any[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  if (process.env.TURN_URL) {
    // Vergüllə ayrılmış çoxlu TURN URL dəstəklənir — məs. Metered bir neçə
    // port/transport verir (80, 443, turns). Biri bağlıdırsa digəri işləyir.
    const urls = process.env.TURN_URL.split(',').map((u) => u.trim()).filter(Boolean);
    if (urls.length) {
      servers.push({
        urls: urls.length > 1 ? urls : urls[0],
        username: process.env.TURN_USERNAME || '',
        credential: process.env.TURN_CREDENTIAL || '',
      });
    }
  }
  return servers;
}

export function initCallSignaling(httpServer: HttpServer, allowedOrigins: string[]) {
  const io = new Server(httpServer, {
    cors: { origin: allowedOrigins, credentials: true },
    path: '/socket.io',
  });
  ioRef = io;

  // Auth — handshake-də JWT token tələb olunur.
  io.use((socket, next) => {
    const userId = verifyTokenUserId(socket.handshake.auth?.token);
    if (!userId) return next(new Error('auth'));
    (socket as any).userId = userId;
    next();
  });

  io.on('connection', (socket: Socket) => {
    const userId = (socket as any).userId as number;
    // Join-dan ƏVVƏL: bu istifadəçi əvvəl onlayn idimi? Deyilsə, bu qoşulma
    // onu onlayn edir → tərəflərə "online" yayımla.
    const wasOnline = isUserOnline(userId);
    // Hər istifadəçi öz otağına qoşulur — çoxlu cihaz/tab dəstəklənir.
    socket.join(`u:${userId}`);
    if (!wasOnline) broadcastPresence(userId, true).catch(() => {});
    // ICE konfiqurasiyasını dərhal göndər.
    socket.emit('config', { iceServers: iceServers() });

    // İstənilən istifadəçilərin online/son-görülmə vəziyyətini soruş (siyahı açılanda).
    socket.on('presence:get', async (p: { ids?: number[] }) => {
      const ids = Array.isArray(p?.ids) ? p.ids.filter((n) => Number.isInteger(n)).slice(0, 300) : [];
      if (!ids.length) return;
      try {
        const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, lastSeen: true } });
        const seen = new Map(users.map((u) => [u.id, u.lastSeen]));
        socket.emit('presence:list', ids.map((id) => ({
          userId: id,
          online: isUserOnline(id),
          lastSeen: seen.get(id) ? (seen.get(id) as Date).toISOString() : null,
        })));
      } catch { /* sükutla ötür */ }
    });

    // Zəng dəvəti — qarşı tərəf onlayndırsa "call:incoming" alır.
    socket.on('call:invite', async (p: { to: number; kind: 'audio' | 'video' }) => {
      try {
        const to = parseInt(String(p?.to));
        const kind = p?.kind === 'video' ? 'video' : 'audio';
        if (!to || to === userId) return;
        const room = io.sockets.adapter.rooms.get(`u:${to}`);
        if (!room || room.size === 0) {
          socket.emit('call:unavailable', { to });
          return;
        }
        const me = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, avatar: true } });
        io.to(`u:${to}`).emit('call:incoming', { from: me, kind });
      } catch { /* signaling xətaları səssiz keçilir */ }
    });

    // Qəbul / imtina / bitirmə / məşğul — sadə ötürmə.
    socket.on('call:accept', (p: { to: number }) => {
      const to = parseInt(String(p?.to));
      if (to) io.to(`u:${to}`).emit('call:accepted', { from: userId });
    });
    socket.on('call:reject', (p: { to: number; busy?: boolean }) => {
      const to = parseInt(String(p?.to));
      if (to) io.to(`u:${to}`).emit('call:rejected', { from: userId, busy: !!p?.busy });
    });
    socket.on('call:end', (p: { to: number }) => {
      const to = parseInt(String(p?.to));
      if (to) io.to(`u:${to}`).emit('call:ended', { from: userId });
    });

    // WebRTC siqnalları (SDP offer/answer + ICE candidate) — birbaşa ötürülür.
    socket.on('call:signal', (p: { to: number; data: any }) => {
      const to = parseInt(String(p?.to));
      if (to && p?.data) io.to(`u:${to}`).emit('call:signal', { from: userId, data: p.data });
    });

    // ── Çat: "yazır..." göstəricisi (yalnız ötürülür, saxlanmır) ──
    socket.on('chat:typing', (p: { to: number }) => {
      const to = parseInt(String(p?.to));
      if (to && to !== userId) io.to(`u:${to}`).emit('chat:typing', { from: userId });
    });
    socket.on('chat:stopTyping', (p: { to: number }) => {
      const to = parseInt(String(p?.to));
      if (to && to !== userId) io.to(`u:${to}`).emit('chat:stopTyping', { from: userId });
    });

    // ── Qrup zəngi (mesh WebRTC) — hər iştirakçı digərləri ilə birbaşa qoşulur ──
    // Ortaq qoşulma məntiqi: limit yoxla, istifadəçini otağa əlavə et, ONA mövcud
    // iştirakçıların siyahısını göndər (groupcall:participants) və MÖVCUD
    // iştirakçıları yeni gələnlə xəbərdar et (groupcall:peer-joined). Beləliklə
    // həm "start", həm "join" edən mesh-ə düzgün qoşulur (əvvəl yalnız "join"
    // bunu edirdi — "start" edən heç kimi görmürdü, ona görə qrup zəngi işləmirdi).
    const joinGroupRoom = async (cid: number): Promise<boolean> => {
      let set = groupCalls.get(cid); if (!set) { set = new Set(); groupCalls.set(cid, set); }
      if (!set.has(userId) && set.size >= MAX_GROUP_CALL) {
        socket.emit('groupcall:full', { conversationId: cid, max: MAX_GROUP_CALL });
        return false;
      }
      const existing = Array.from(set).filter((id) => id !== userId);
      set.add(userId);
      const users = await prisma.user.findMany({ where: { id: { in: existing.length ? existing : [-1] } }, select: { id: true, name: true, avatar: true } });
      socket.emit('groupcall:participants', { conversationId: cid, participants: users });
      const me = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, avatar: true } });
      existing.forEach((id) => io.to(`u:${id}`).emit('groupcall:peer-joined', { conversationId: cid, peer: me }));
      await broadcastGroupCallState(cid); // qrupdakı hər kəs "Qoşul" bannerini görsün/yenilənsin
      return true;
    };

    // Başlat — özü də mesh-ə qoşulur VƏ hələ qoşulmayan qrup üzvlərinə dəvət göndərir.
    socket.on('groupcall:start', async (p: { conversationId: number; kind: 'audio' | 'video' }) => {
      try {
        const cid = parseInt(String(p?.conversationId));
        const kind = p?.kind === 'video' ? 'video' : 'audio';
        if (!cid) return;
        const members = await groupMemberIds(cid);
        if (!members.includes(userId)) return;
        const wasEmpty = !(groupCalls.get(cid)?.size);
        groupCallKind.set(cid, kind);
        if (!(await joinGroupRoom(cid))) return;
        // Yeni zəng başlayanda tarixçə üçün CALL mesajı yarat (qrup söhbətində qalır).
        if (wasEmpty) {
          try {
            const msg = await prisma.message.create({ data: { senderId: userId, conversationId: cid, type: 'CALL', callKind: kind, callStatus: 'ongoing', content: kind === 'video' ? 'Qrup görüntülü zəng' : 'Qrup səsli zəng' } as any });
            groupCallMsg.set(cid, msg.id);
          } catch { /* keç */ }
        }
        const set = groupCalls.get(cid);
        const me = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, avatar: true } });
        members.filter((m) => m !== userId && !set?.has(m)).forEach((m) => io.to(`u:${m}`).emit('groupcall:incoming', { conversationId: cid, kind, from: me }));
      } catch { /* keç */ }
    });

    // Status sorğusu — qrupu açan istifadəçi aktiv zəng olub-olmadığını öyrənir.
    socket.on('groupcall:status', async (p: { conversationId: number }) => {
      const cid = parseInt(String(p?.conversationId));
      if (!cid) return;
      const set = groupCalls.get(cid);
      const ids = set ? Array.from(set) : [];
      const participants = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, avatar: true } }) : [];
      socket.emit('groupcall:state', { conversationId: cid, active: ids.length > 0, count: ids.length, kind: groupCallKind.get(cid) || 'audio', participants });
    });

    // Qrup zəngi zamanı bütün qrup üzvlərini (online/offline) göstərmək üçün roster.
    // Üzvlərin hamısını qaytarır + hər birinin online vəziyyətini (isUserOnline).
    socket.on('groupcall:roster', async (p: { conversationId: number }) => {
      try {
        const cid = parseInt(String(p?.conversationId));
        if (!cid) return;
        const members = await groupMemberIds(cid);
        if (!members.includes(userId)) return;
        const users = await prisma.user.findMany({ where: { id: { in: members } }, select: { id: true, name: true, avatar: true } });
        socket.emit('groupcall:roster', {
          conversationId: cid,
          members: users.map((u) => ({ id: u.id, name: u.name, avatar: u.avatar, online: isUserOnline(u.id) })),
        });
      } catch { /* keç */ }
    });

    // Qoşul — dəvəti (incoming) qəbul edən iştirakçı üçün: sadəcə mesh-ə qoşulur.
    socket.on('groupcall:join', async (p: { conversationId: number }) => {
      try {
        const cid = parseInt(String(p?.conversationId));
        if (!cid) return;
        const members = await groupMemberIds(cid);
        if (!members.includes(userId)) return;
        await joinGroupRoom(cid);
      } catch { /* keç */ }
    });

    // Mesh siqnalı — konkret iştirakçıya SDP/ICE ötür.
    socket.on('groupcall:signal', (p: { conversationId: number; to: number; data: any }) => {
      const to = parseInt(String(p?.to));
      const cid = parseInt(String(p?.conversationId));
      if (to && p?.data) io.to(`u:${to}`).emit('groupcall:signal', { conversationId: cid, from: userId, data: p.data });
    });

    // Çıx — digər iştirakçıları xəbərdar et; zəng boşalanda tarixçəni bağla + broadcast.
    const leaveGroupCall = async (cid: number) => {
      const set = groupCalls.get(cid);
      if (!set) return;
      if (set.delete(userId)) {
        if (set.size === 0) {
          groupCalls.delete(cid);
          groupCallKind.delete(cid);
          // Tarixçə mesajını "bitdi" et.
          const mid = groupCallMsg.get(cid);
          if (mid) { groupCallMsg.delete(cid); await prisma.message.update({ where: { id: mid }, data: { callStatus: 'ended' } as any }).catch(() => {}); }
        } else {
          set.forEach((id) => io.to(`u:${id}`).emit('groupcall:peer-left', { conversationId: cid, userId }));
        }
        await broadcastGroupCallState(cid);
      }
    };
    socket.on('groupcall:leave', (p: { conversationId: number }) => { const cid = parseInt(String(p?.conversationId)); if (cid) leaveGroupCall(cid); });

    // Bağlantı kəsilsə bütün qrup zənglərindən çıxar.
    socket.on('disconnect', async () => {
      for (const cid of Array.from(groupCalls.keys())) await leaveGroupCall(cid);
      // socket.io disconnect anında bu socket otaqdan çıxarılıb — başqa cihaz/tab
      // qalmayıbsa istifadəçi offline olur.
      if (isUserOnline(userId)) return;
      const lastSeen = new Date();
      try { await prisma.user.update({ where: { id: userId }, data: { lastSeen } }); } catch { /* sükutla ötür */ }
      broadcastPresence(userId, false, lastSeen).catch(() => {});
    });
  });

  return io;
}
