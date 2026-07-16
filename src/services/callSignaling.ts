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
    servers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
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
  });

  return io;
}
