import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import dotenv from 'dotenv';
import { Server } from 'socket.io';
import { MongoClient } from 'mongodb';

dotenv.config();
const PORT = Number(process.env.PORT || 4000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const app = express();
app.disable('x-powered-by');
app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use(express.json({ limit: '1mb' }));
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] } });

let mongoClient;
let positionsCollection;
let roomsCollection;
if (process.env.MONGODB_URI) {
  try {
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    await mongoClient.connect();
    const db = mongoClient.db('proxispeak');
    positionsCollection = db.collection('positions');
    roomsCollection = db.collection('rooms');
    await positionsCollection.createIndex({ roomId: 1, socketId: 1 }, { unique: true });
    await positionsCollection.createIndex({ location: '2dsphere' });
    await roomsCollection.createIndex({ roomId: 1 }, { unique: true });
    console.log('MongoDB connected; indexes ready');
  } catch (error) {
    console.error('MongoDB setup failed; continuing in-memory:', error.message);
  }
}

const users = new Map();
let redisClients = null;

if (process.env.REDIS_URL) {
  try {
    const pubClient = createClient({ url: process.env.REDIS_URL });
    const subClient = pubClient.duplicate();
    pubClient.on('error', (e) => console.error('Redis publisher error:', e.message));
    subClient.on('error', (e) => console.error('Redis subscriber error:', e.message));
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    redisClients = [pubClient, subClient];
    console.log('Socket.IO Redis adapter enabled');
  } catch (error) {
    console.error('Redis adapter unavailable; using single-instance Socket.IO:', error.message);
  }
}
const validCoord = (v, max, fallback) => Number.isFinite(Number(v)) ? Math.max(24, Math.min(max, Number(v))) : fallback;
const roomUsers = (roomId) => [...users.values()].filter((u) => u.roomId === roomId);

app.get('/api/health', (_req, res) => res.json({
  ok: true, service: 'ProxiSpeak', connectedUsers: users.size,
  persistence: Boolean(positionsCollection), redisAdapter: Boolean(redisClients)
}));
app.get('/api/ready', (_req, res) => {
  if (process.env.MONGODB_URI && !positionsCollection) return res.status(503).json({ ready: false, reason: 'MongoDB unavailable' });
  res.json({ ready: true });
});
app.get('/api/users', (req, res) => {
  const roomId = String(req.query.roomId || 'main-office');
  res.json(roomUsers(roomId));
});
app.get('/api/rooms/:roomId', async (req, res) => {
  try {
    const roomId = String(req.params.roomId).slice(0, 40);
    const saved = roomsCollection ? await roomsCollection.findOne({ roomId }) : null;
    res.json(saved || { roomId, layout: 'default', persisted: false });
  } catch (e) { res.status(500).json({ error: 'Could not load room layout' }); }
});
app.put('/api/rooms/:roomId', async (req, res) => {
  if (!roomsCollection) return res.status(503).json({ error: 'Configure MONGODB_URI to persist room layouts' });
  const roomId = String(req.params.roomId).slice(0, 40);
  const layout = req.body?.layout;
  if (!layout || typeof layout !== 'object') return res.status(400).json({ error: 'layout object required' });
  try {
    await roomsCollection.updateOne({ roomId }, { $set: { roomId, layout, updatedAt: new Date() } }, { upsert: true });
    res.json({ ok: true, roomId });
  } catch (e) { res.status(500).json({ error: 'Could not save room layout' }); }
});

io.on('connection', (socket) => {
  socket.on('office:join', async ({ name, roomId } = {}) => {
    const safeName = String(name || 'Guest').trim().slice(0, 24) || 'Guest';
    const safeRoom = String(roomId || 'main-office').trim().slice(0, 40) || 'main-office';
    socket.data.roomId = safeRoom;
    socket.join(safeRoom);
    const user = { id: socket.id, name: safeName, roomId: safeRoom,
      x: 120 + Math.random() * 480, y: 100 + Math.random() * 280,
      joinedAt: new Date().toISOString() };
    users.set(socket.id, user);
    if (positionsCollection) {
      positionsCollection.updateOne({ roomId: safeRoom, socketId: socket.id },
        { $set: { ...user, socketId: socket.id, location: { type: 'Point', coordinates: [user.x, user.y] }, updatedAt: new Date() } },
        { upsert: true }).catch((e) => console.error('Mongo position save failed:', e.message));
    }
    socket.emit('office:joined', { selfId: socket.id, users: roomUsers(safeRoom) });
    socket.to(safeRoom).emit('user:joined', user);
    io.to(safeRoom).emit('users:update', roomUsers(safeRoom));
  });

  socket.on('avatar:move', ({ x, y } = {}) => {
    const user = users.get(socket.id);
    if (!user) return;
    user.x = validCoord(x, 776, user.x);
    user.y = validCoord(y, 476, user.y);
    users.set(socket.id, user);
    if (positionsCollection) {
      positionsCollection.updateOne({ roomId: user.roomId, socketId: socket.id },
        { $set: { x: user.x, y: user.y,
          location: { type: 'Point', coordinates: [user.x, user.y] }, updatedAt: new Date() } })
        .catch((e) => console.error('Mongo position update failed:', e.message));
    }
    io.to(user.roomId).emit('avatar:moved', user);
    io.to(user.roomId).emit('users:update', roomUsers(user.roomId));
  });

  socket.on('audio:signal', ({ targetId, signal } = {}) => {
    if (!targetId || !signal || !users.has(socket.id) || !users.has(targetId)) return;
    if (users.get(socket.id).roomId !== users.get(targetId).roomId) return;
    io.to(targetId).emit('audio:signal', { fromId: socket.id, signal });
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      users.delete(socket.id);
      if (positionsCollection) positionsCollection.deleteOne({ roomId: user.roomId, socketId: socket.id })
        .catch((e) => console.error('Mongo position cleanup failed:', e.message));
      io.to(user.roomId).emit('user:left', { id: socket.id });
      io.to(user.roomId).emit('users:update', roomUsers(user.roomId));
    }
  });
});

httpServer.listen(PORT, () => console.log(`ProxiSpeak server running at http://localhost:${PORT}`));
