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

import {
  distance2D,
  filterNearbyUsers,
  clusterUsers,
} from './lib/spatial.js';

dotenv.config();

const PORT = Number(process.env.PORT || 4000);
const CLIENT_ORIGIN =
  process.env.CLIENT_ORIGIN || 'http://localhost:5173';

const AWAY_AFTER_MS = 60_000;
const PRESENCE_REFRESH_MS = 15_000;
const PROXIMITY_RADIUS = 100;

// MongoDB's legacy 2d index uses a limited coordinate range.
// Scale canvas pixels down by 10 before storing them in MongoDB.
const COORD_SCALE = 10;

const toIndexedCoords = (x, y) => [
  x / COORD_SCALE,
  y / COORD_SCALE,
];

const app = express();

app.disable('x-powered-by');
app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: CLIENT_ORIGIN }));

app.use(
  '/api/',
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })
);

app.use(express.json({ limit: '1mb' }));

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ['GET', 'POST'],
  },
});

// --------------------------------------------------
// MONGODB
// --------------------------------------------------

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

    await positionsCollection.createIndex(
      { roomId: 1, socketId: 1 },
      { unique: true }
    );

    // IMPORTANT: the 2d index field must come first.
    await positionsCollection.createIndex({
      coords: '2d',
      roomId: 1,
    });

    await roomsCollection.createIndex(
      { roomId: 1 },
      { unique: true }
    );

    console.log('MongoDB connected; indexes ready');
  } catch (error) {
    console.error(
      'MongoDB setup failed; continuing in-memory:',
      error.message
    );

    positionsCollection = null;
    roomsCollection = null;

    if (mongoClient) {
      await mongoClient.close().catch(() => {});
      mongoClient = null;
    }
  }
} else {
  console.warn(
    'MONGODB_URI is not configured. Running without persistence.'
  );
}

// --------------------------------------------------
// USERS AND VALIDATION
// --------------------------------------------------

const users = new Map();
let redisClients = null;

const roomUsers = (roomId) =>
  [...users.values()].filter(
    (user) => user.roomId === roomId
  );

const broadcastRoomUsers = (roomId) => {
  io.to(roomId).emit('users:update', roomUsers(roomId));
};

const validCoord = (value, max) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(24, Math.min(max, value));
};

// --------------------------------------------------
// SPATIAL PROXIMITY HELPERS
// --------------------------------------------------

const getDistance = (userA, userB) =>
  distance2D(userA, userB);

const findNearbyUsers = async (
  roomId,
  x,
  y,
  excludeSocketId
) => {
  if (positionsCollection) {
    try {
      const documents = await positionsCollection
        .find({
          roomId,
          socketId: { $ne: excludeSocketId },
          coords: {
            $near: toIndexedCoords(x, y),
            $maxDistance: PROXIMITY_RADIUS / COORD_SCALE,
          },
        })
        .toArray();
        console.log('\n========== MONGODB $near QUERY ==========');
console.log('Room:', roomId);
console.log('Coordinates:', toIndexedCoords(x, y));
console.log(
  'Maximum distance:',
  PROXIMITY_RADIUS / COORD_SCALE
);
console.log('=========================================\n');

      // Return only users currently connected to this server.
      const activeSocketIds = new Set(
        roomUsers(roomId).map((user) => user.id)
      );

      return documents
        .filter((document) =>
          activeSocketIds.has(document.socketId)
        )
        .map((document) => ({
          ...document,
          id: document.socketId,
        }));
    } catch (error) {
      console.error(
        'MongoDB $near query failed; using in-memory fallback:',
        error.message
      );
    }
  }

  // In-memory fallback if MongoDB is unavailable or the query fails.
  const participants = roomUsers(roomId);

  const currentUser = {
    id: excludeSocketId,
    roomId,
    x,
    y,
  };

  const clusters = clusterUsers(
    participants,
    PROXIMITY_RADIUS
  );

  const cellX = Math.floor(x / PROXIMITY_RADIUS);
  const cellY = Math.floor(y / PROXIMITY_RADIUS);
  const candidates = [];

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const key =
        `${roomId}:${cellX + dx}:${cellY + dy}`;

      const cellUsers = clusters.get(key);

      if (cellUsers) {
        candidates.push(...cellUsers);
      }
    }
  }

  return filterNearbyUsers(
    candidates,
    currentUser,
    PROXIMITY_RADIUS
  );
};

const updateProximityForSocket = async (socket, user) => {
  const nearbyUsers = await findNearbyUsers(
    user.roomId,
    user.x,
    user.y,
    socket.id
  );

  socket.emit('proximity:update', {
    radius: PROXIMITY_RADIUS,
    nearbyUserIds: nearbyUsers.map(
      (nearbyUser) => nearbyUser.id
    ),
  });
};

const broadcastRoomProximity = async (roomId) => {
  const participants = roomUsers(roomId);

  await Promise.all(
    participants.map(async (user) => {
      const participantSocket =
        io.sockets.sockets.get(user.id);

      if (participantSocket) {
        try {
          await updateProximityForSocket(
            participantSocket,
            user
          );
        } catch (error) {
          console.error(
            'Proximity update failed:',
            error.message
          );
        }
      }
    })
  );
};

// --------------------------------------------------
// REDIS ADAPTER (OPTIONAL)
// --------------------------------------------------

if (process.env.REDIS_URL) {
  try {
    const pubClient = createClient({
      url: process.env.REDIS_URL,
    });

    const subClient = pubClient.duplicate();

    pubClient.on('error', (error) =>
      console.error('Redis publisher error:', error.message)
    );

    subClient.on('error', (error) =>
      console.error('Redis subscriber error:', error.message)
    );

    await Promise.all([
      pubClient.connect(),
      subClient.connect(),
    ]);

    io.adapter(createAdapter(pubClient, subClient));

    redisClients = [pubClient, subClient];

    console.log('Socket.IO Redis adapter enabled');
  } catch (error) {
    console.error(
      'Redis adapter unavailable; using single-instance Socket.IO:',
      error.message
    );
  }
}

// --------------------------------------------------
// HTTP API ROUTES
// --------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'ProxiSpeak',
    connectedUsers: users.size,
    persistence: Boolean(positionsCollection),
    redisAdapter: Boolean(redisClients),
  });
});

app.get('/api/ready', (_req, res) => {
  if (process.env.MONGODB_URI && !positionsCollection) {
    return res.status(503).json({
      ready: false,
      reason: 'MongoDB unavailable',
    });
  }

  res.json({ ready: true });
});

app.get('/api/users', (req, res) => {
  const roomId = String(
    req.query.roomId || 'main-office'
  ).slice(0, 40);

  res.json(roomUsers(roomId));
});

app.get('/api/rooms/:roomId', async (req, res) => {
  try {
    const roomId = String(req.params.roomId).slice(0, 40);

    const saved = roomsCollection
      ? await roomsCollection.findOne({ roomId })
      : null;

    res.json(
      saved || {
        roomId,
        layout: 'default',
        persisted: false,
      }
    );
  } catch (error) {
    console.error('Room layout load failed:', error.message);

    res.status(500).json({
      error: 'Could not load room layout',
    });
  }
});

app.put('/api/rooms/:roomId', async (req, res) => {
  if (!roomsCollection) {
    return res.status(503).json({
      error: 'Configure MONGODB_URI to persist room layouts',
    });
  }

  const roomId = String(req.params.roomId).slice(0, 40);
  const layout = req.body?.layout;

  if (
    !layout ||
    typeof layout !== 'object' ||
    Array.isArray(layout)
  ) {
    return res.status(400).json({
      error: 'layout object required',
    });
  }

  try {
    await roomsCollection.updateOne(
      { roomId },
      {
        $set: {
          roomId,
          layout,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    res.json({ ok: true, roomId });
  } catch (error) {
    console.error('Room layout save failed:', error.message);

    res.status(500).json({
      error: 'Could not save room layout',
    });
  }
});

// --------------------------------------------------
// SOCKET.IO EVENTS
// --------------------------------------------------

io.on('connection', (socket) => {
  // JOIN OFFICE
  socket.on('office:join', async (payload = {}) => {
    if (users.has(socket.id)) {
      socket.emit('office:join:error', {
        message: 'You have already joined a room.',
      });
      return;
    }

    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      socket.emit('office:join:error', {
        message: 'Invalid join request.',
      });
      return;
    }

    const { name, roomId } = payload;

    const safeName =
      String(name || 'Guest').trim().slice(0, 24) ||
      'Guest';

    const safeRoom =
      String(roomId || 'main-office').trim().slice(0, 40) ||
      'main-office';

    const user = {
      id: socket.id,
      name: safeName,
      roomId: safeRoom,
      x: 120 + Math.random() * 480,
      y: 100 + Math.random() * 280,
      joinedAt: new Date().toISOString(),
      status: 'online',
      manualStatus: 'auto',
      lastActivityAt: Date.now(),
    };

    socket.data.roomId = safeRoom;
    socket.join(safeRoom);
    users.set(socket.id, user);

    if (positionsCollection) {
      try {
        await positionsCollection.updateOne(
          { roomId: safeRoom, socketId: socket.id },
          {
            $set: {
              ...user,
              socketId: socket.id,
              coords: toIndexedCoords(user.x, user.y),
              updatedAt: new Date(),
            },
          },
          { upsert: true }
        );
      } catch (error) {
        console.error(
          'Mongo position save failed:',
          error.message
        );
      }
    }

    socket.emit('office:joined', {
      selfId: socket.id,
      users: roomUsers(safeRoom),
    });

    socket.to(safeRoom).emit('user:joined', user);

    broadcastRoomUsers(safeRoom);
    await broadcastRoomProximity(safeRoom);
  });

  // MANUAL PRESENCE STATUS
  socket.on('presence:update', (payload = {}) => {
    const user = users.get(socket.id);
    if (!user) return;

    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      return;
    }

    const requestedStatus = payload.status;

    if (
      !['online', 'away', 'auto'].includes(requestedStatus)
    ) {
      return;
    }

    user.manualStatus = requestedStatus;

    if (requestedStatus === 'auto') {
      user.status =
        Date.now() - user.lastActivityAt >= AWAY_AFTER_MS
          ? 'away'
          : 'online';
    } else {
      user.status = requestedStatus;
    }

    users.set(socket.id, user);
    broadcastRoomUsers(user.roomId);

    if (positionsCollection) {
      positionsCollection.updateOne(
        { roomId: user.roomId, socketId: socket.id },
        {
          $set: {
            status: user.status,
            manualStatus: user.manualStatus,
            updatedAt: new Date(),
          },
        }
      ).catch((error) => {
        console.error(
          'Mongo presence update failed:',
          error.message
        );
      });
    }
  });

  // VALIDATED AVATAR MOVEMENT
  socket.on('avatar:move', async (payload) => {
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      return;
    }

    const user = users.get(socket.id);
    if (!user) return;

    const nextX = validCoord(payload.x, 776);
    const nextY = validCoord(payload.y, 476);

    if (nextX === null || nextY === null) {
      socket.emit('avatar:move:error', {
        message: 'Invalid movement coordinates.',
      });
      return;
    }

    user.x = nextX;
    user.y = nextY;

    const previousStatus = user.status;
    user.lastActivityAt = Date.now();

    if (user.manualStatus === 'auto') {
      user.status = 'online';
    }

    users.set(socket.id, user);

    if (previousStatus !== user.status) {
      broadcastRoomUsers(user.roomId);
    }

    if (positionsCollection) {
      try {
        await positionsCollection.updateOne(
          { roomId: user.roomId, socketId: socket.id },
          {
            $set: {
              x: user.x,
              y: user.y,
              coords: toIndexedCoords(user.x, user.y),
              status: user.status,
              lastActivityAt: user.lastActivityAt,
              updatedAt: new Date(),
            },
          },
          { upsert: true }
        );
      } catch (error) {
        console.error(
          'Mongo position update failed:',
          error.message
        );
      }
    }

    io.to(user.roomId).emit('avatar:moved', user);

    await broadcastRoomProximity(user.roomId);
  });

  // AUDIO SIGNALING
  socket.on('audio:signal', (payload = {}) => {
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      return;
    }

    const { targetId, signal } = payload;
    if (!targetId || !signal) return;

    const sender = users.get(socket.id);
    const target = users.get(targetId);

    if (!sender || !target) return;
    if (sender.roomId !== target.roomId) return;

    if (
      ![
        sender.x,
        sender.y,
        target.x,
        target.y,
      ].every(Number.isFinite)
    ) {
      return;
    }

    const distance = getDistance(sender, target);

    if (distance > PROXIMITY_RADIUS) {
      return;
    }

    io.to(targetId).emit('audio:signal', {
      fromId: socket.id,
      signal,
    });
  });

  // DISCONNECT AND CLEANUP
  socket.on('disconnect', async () => {
    const user = users.get(socket.id);
    if (!user) return;

    users.delete(socket.id);

    if (positionsCollection) {
      try {
        await positionsCollection.deleteOne({
          roomId: user.roomId,
          socketId: socket.id,
        });
      } catch (error) {
        console.error(
          'Mongo position cleanup failed:',
          error.message
        );
      }
    }

    io.to(user.roomId).emit('user:left', {
      id: socket.id,
    });

    broadcastRoomUsers(user.roomId);
    await broadcastRoomProximity(user.roomId);
  });
});

// --------------------------------------------------
// AUTOMATIC PRESENCE REFRESH
// --------------------------------------------------

const presenceTimer = setInterval(() => {
  const now = Date.now();
  const changedRooms = new Set();

  for (const user of users.values()) {
    let nextStatus = user.status;

    if (user.manualStatus === 'away') {
      nextStatus = 'away';
    } else if (user.manualStatus === 'online') {
      nextStatus = 'online';
    } else {
      nextStatus =
        now - user.lastActivityAt >= AWAY_AFTER_MS
          ? 'away'
          : 'online';
    }

    if (nextStatus !== user.status) {
      user.status = nextStatus;
      changedRooms.add(user.roomId);

      if (positionsCollection) {
        positionsCollection.updateOne(
          { roomId: user.roomId, socketId: user.id },
          {
            $set: {
              status: user.status,
              updatedAt: new Date(),
            },
          }
        ).catch((error) => {
          console.error(
            'Mongo automatic presence update failed:',
            error.message
          );
        });
      }
    }
  }

  for (const roomId of changedRooms) {
    broadcastRoomUsers(roomId);
  }
}, PRESENCE_REFRESH_MS);

presenceTimer.unref();

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

httpServer.listen(PORT, () => {
  console.log(
    `ProxiSpeak server running at http://localhost:${PORT}`
  );

  console.log(
    `MongoDB $near proximity radius: ${PROXIMITY_RADIUS} pixels`
  );

  console.log('Spatial utilities integrated successfully');
});

// Graceful shutdown
const shutdown = async () => {
  clearInterval(presenceTimer);

  httpServer.close();

  if (redisClients) {
    await Promise.all(
      redisClients.map((client) =>
        client.quit().catch(() => {})
      )
    );
  }

  if (mongoClient) {
    await mongoClient.close().catch(() => {});
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);