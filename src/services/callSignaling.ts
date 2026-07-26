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
// Bir qrup zəngində maksimum iştirakçı sayı (mesh WebRTC kiçik qruplar üçün).
const MAX_GROUP_CALL = 5;
async function groupMemberIds(conversationId: number): Promise<number[]> {
  const mems = await prisma.conversationMember.findMany({ where: { conversationId }, select: { userId: true } });
  return mems.map((m) => m.userId);
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
    // Hər istifadəçi öz otağına qoşulur — çoxlu cihaz/tab dəstəklənir.
    socket.join(`u:${userId}`);
    // ICE konfiqurasiyasını dərhal göndər.
    socket.emit('config', { iceServers: iceServers() });

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
        if (!(await joinGroupRoom(cid))) return;
        const set = groupCalls.get(cid);
        const me = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, avatar: true } });
        members.filter((m) => m !== userId && !set?.has(m)).forEach((m) => io.to(`u:${m}`).emit('groupcall:incoming', { conversationId: cid, kind, from: me }));
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

    // Çıx — digər iştirakçıları xəbərdar et.
    const leaveGroupCall = (cid: number) => {
      const set = groupCalls.get(cid);
      if (!set) return;
      if (set.delete(userId)) {
        if (set.size === 0) groupCalls.delete(cid);
        else set.forEach((id) => io.to(`u:${id}`).emit('groupcall:peer-left', { conversationId: cid, userId }));
      }
    };
    socket.on('groupcall:leave', (p: { conversationId: number }) => { const cid = parseInt(String(p?.conversationId)); if (cid) leaveGroupCall(cid); });

    // Bağlantı kəsilsə bütün qrup zənglərindən çıxar.
    socket.on('disconnect', () => {
      for (const cid of Array.from(groupCalls.keys())) leaveGroupCall(cid);
    });
  });

  return io;
}
