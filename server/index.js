
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
import { randomUUID } from 'node:crypto';

import {
  distance2D,
  filterNearbyUsers,
} from './lib/spatial.js';

dotenv.config();

const PORT = Number(process.env.PORT || 4000);

const CLIENT_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
];

const AWAY_AFTER_MS = 60_000;
const PRESENCE_REFRESH_MS = 15_000;
const PROXIMITY_RADIUS = 100;
const PRESENCE_TTL_SECONDS = 45;

// Distributed backend instance monitoring.
const INSTANCE_ID = randomUUID();
const INSTANCE_HEARTBEAT_TTL_SECONDS = 60;
const INSTANCE_HEARTBEAT_INTERVAL_MS = 15_000;
const INSTANCE_CLEANUP_INTERVAL_MS = 20_000;
const INSTANCE_USER_SET_TTL_SECONDS = 120;

const instanceHeartbeatKey = (id) =>
  `proxispeak:instance:${id}:heartbeat`;

const instanceUsersKey = (id) =>
  `proxispeak:instance:${id}:users`;

const COORD_SCALE = 10;

const toIndexedCoords = (x, y) => [
  x / COORD_SCALE,
  y / COORD_SCALE,
];

const app = express();

app.disable('x-powered-by');
app.use(helmet({ crossOriginEmbedderPolicy: false }));

app.use(
  cors({
    origin: CLIENT_ORIGINS,
  })
);

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
    origin: CLIENT_ORIGINS,
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
    console.error('MongoDB setup failed:', error.message);

    positionsCollection = null;
    roomsCollection = null;

    if (mongoClient) {
      await mongoClient.close().catch(() => {});
      mongoClient = null;
    }
  }
} else {
  console.warn('MONGODB_URI is not configured.');
}

// --------------------------------------------------
// LOCAL USERS AND SHARED REDIS PRESENCE
// --------------------------------------------------

const users = new Map();
let redisClients = null;

const roomUsers = (roomId) =>
  [...users.values()].filter(
    (user) => user.roomId === roomId
  );

const presenceRedis = () => redisClients?.[0] || null;

const userPresenceKey = (socketId) =>
  `proxispeak:presence:user:${socketId}`;

const roomPresenceKey = (roomId) =>
  `proxispeak:presence:room:${roomId}`;

// Store user information in Redis.
const saveSharedUser = async (user) => {
  const redis = presenceRedis();

  if (!redis) return;

  const sharedUser = {
    ...user,
    instanceId: INSTANCE_ID,
  };

  await redis.set(
    userPresenceKey(user.id),
    JSON.stringify(sharedUser),
    { EX: PRESENCE_TTL_SECONDS }
  );

  await redis.sAdd(
    roomPresenceKey(user.roomId),
    user.id
  );

  // Index sockets owned by this process for crash recovery.
  await redis.sAdd(
    instanceUsersKey(INSTANCE_ID),
    user.id
  );

  await redis.expire(
    instanceUsersKey(INSTANCE_ID),
    INSTANCE_USER_SET_TTL_SECONDS
  );
};

// Retrieve one user from shared Redis presence.
const getSharedUser = async (socketId) => {
  const redis = presenceRedis();

  if (!redis) {
    return users.get(socketId) || null;
  }

  const value = await redis.get(
    userPresenceKey(socketId)
  );

  if (!value) return null;

  try {
    return JSON.parse(value);
  } catch {
    await redis.del(userPresenceKey(socketId));
    return null;
  }
};

// Retrieve every active user in a room.
const getRoomUsers = async (roomId) => {
  const redis = presenceRedis();

  if (!redis) {
    return roomUsers(roomId);
  }

  const socketIds = await redis.sMembers(
    roomPresenceKey(roomId)
  );

  if (!socketIds.length) return [];

  const values = await Promise.all(
    socketIds.map((id) =>
      redis.get(userPresenceKey(id))
    )
  );

  const activeUsers = [];
  const staleIds = [];

  values.forEach((value, index) => {
    if (!value) {
      staleIds.push(socketIds[index]);
      return;
    }

    try {
      const user = JSON.parse(value);

      if (user.roomId === roomId) {
        activeUsers.push(user);
      } else {
        staleIds.push(socketIds[index]);
      }
    } catch {
      staleIds.push(socketIds[index]);
    }
  });

  if (staleIds.length) {
    await redis.sRem(
      roomPresenceKey(roomId),
      staleIds
    );
  }

  return activeUsers;
};

// Broadcast the shared room roster to both instances.
const broadcastRoomUsers = async (roomId) => {
  const participants = await getRoomUsers(roomId);

  io.to(roomId).emit('users:update', participants);

  return participants;
};

const updateSharedUser = async (user) => {
  await saveSharedUser(user);
};

// --------------------------------------------------
// DISTRIBUTED INSTANCE HEARTBEAT AND RECOVERY
// --------------------------------------------------

const writeInstanceHeartbeat = async () => {
  const redis = presenceRedis();
  if (!redis) return;

  await redis.set(
    instanceHeartbeatKey(INSTANCE_ID),
    String(Date.now()),
    { EX: INSTANCE_HEARTBEAT_TTL_SECONDS }
  );

  await redis.expire(
    instanceUsersKey(INSTANCE_ID),
    INSTANCE_USER_SET_TTL_SECONDS
  );
};

const cleanupFailedInstance = async (failedInstanceId) => {
  const redis = presenceRedis();

  if (!redis || !failedInstanceId || failedInstanceId === INSTANCE_ID) {
    return;
  }

  // Recheck immediately before cleanup.
  if (await redis.exists(instanceHeartbeatKey(failedInstanceId))) {
    return;
  }

  const failedUsersKey = instanceUsersKey(failedInstanceId);
  const socketIds = await redis.sMembers(failedUsersKey);
  const affectedRooms = new Set();

  for (const socketId of socketIds) {
    const presenceKey = userPresenceKey(socketId);
    const raw = await redis.get(presenceKey);

    if (raw) {
      try {
        const user = JSON.parse(raw);

        // Never remove a record that has been reassigned.
        if (user.instanceId !== failedInstanceId) {
          continue;
        }

        await redis.del(presenceKey);
        await redis.sRem(roomPresenceKey(user.roomId), socketId);
        affectedRooms.add(user.roomId);

        if (positionsCollection) {
          await positionsCollection.deleteOne({
            roomId: user.roomId,
            socketId,
          });
        }
      } catch (error) {
        console.error(
          `Could not clean presence for ${socketId}:`,
          error.message
        );
      }
    } else {
      // The user's short-lived presence key may have expired already.
      // Remove its ID from room sets and MongoDB using the unique socket ID.
      try {
        for await (const roomKey of redis.scanIterator({
          MATCH: 'proxispeak:presence:room:*',
          COUNT: 100,
        })) {
          const removed = await redis.sRem(roomKey, socketId);

          if (removed) {
            const roomId = roomKey.replace(
              'proxispeak:presence:room:',
              ''
            );
            affectedRooms.add(roomId);
          }
        }

        if (positionsCollection) {
          await positionsCollection.deleteMany({ socketId });
        }
      } catch (error) {
        console.error(
          `Stale socket cleanup failed for ${socketId}:`,
          error.message
        );
      }
    }
  }

  await redis.del(failedUsersKey);
  await redis.del(instanceHeartbeatKey(failedInstanceId));

  for (const roomId of affectedRooms) {
    try {
      await broadcastRoomUsers(roomId);
      await broadcastRoomProximity(roomId);

      io.to(roomId).emit('presence:instance-recovered', {
        instanceId: failedInstanceId,
      });
    } catch (error) {
      console.error(
        `Recovery broadcast failed for room ${roomId}:`,
        error.message
      );
    }
  }

  if (socketIds.length) {
    console.log(
      `Recovered instance ${failedInstanceId}; processed ${socketIds.length} tracked socket(s)`
    );
  }
};

const recoverFailedInstances = async () => {
  const redis = presenceRedis();
  if (!redis) return;

  try {
    // The per-instance user index outlives the heartbeat long enough
    // to identify owners whose heartbeat has expired.
    for await (const key of redis.scanIterator({
      MATCH: 'proxispeak:instance:*:users',
      COUNT: 100,
    })) {
      const failedInstanceId = key
        .replace('proxispeak:instance:', '')
        .replace(':users', '');

      if (!failedInstanceId || failedInstanceId === INSTANCE_ID) {
        continue;
      }

      const heartbeatAlive = await redis.exists(
        instanceHeartbeatKey(failedInstanceId)
      );

      if (!heartbeatAlive) {
        await cleanupFailedInstance(failedInstanceId);
      }
    }
  } catch (error) {
    console.error(
      'Failed-instance recovery scan failed:',
      error.message
    );
  }
};

const validCoord = (value, max) => {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value)
  ) {
    return null;
  }

  return Math.max(24, Math.min(max, value));
};


// --------------------------------------------------
// REDIS ADAPTER
// --------------------------------------------------

if (process.env.REDIS_URL) {
  let pubClient;
  let subClient;

  try {
    pubClient = createClient({
      url: process.env.REDIS_URL,
    });

    subClient = pubClient.duplicate();

    pubClient.on('error', (error) => {
      console.error('Redis publisher error:', error.message);
    });

    subClient.on('error', (error) => {
      console.error('Redis subscriber error:', error.message);
    });

    await Promise.all([
      pubClient.connect(),
      subClient.connect(),
    ]);

    io.adapter(createAdapter(pubClient, subClient));

    redisClients = [pubClient, subClient];

    console.log('Redis connected:', process.env.REDIS_URL);
    console.log('Socket.IO Redis adapter enabled');
  } catch (error) {
    console.error(
      'Redis adapter setup failed:',
      error.message
    );

    await Promise.allSettled(
      [pubClient, subClient]
        .filter((client) => client?.isOpen)
        .map((client) => client.quit())
    );

    redisClients = null;
  }
} else {
  console.warn(
    'REDIS_URL missing. Running in single-instance mode.'
  );
}

// Register this backend instance after Redis becomes available.
if (presenceRedis()) {
  try {
    await writeInstanceHeartbeat();
    console.log('Backend instance ID:', INSTANCE_ID);
    console.log('Distributed heartbeat registered');
  } catch (error) {
    console.error(
      'Backend heartbeat registration failed:',
      error.message
    );
  }
}

// --------------------------------------------------
// SHARED PROXIMITY DETECTION
// --------------------------------------------------

const getDistance = (userA, userB) =>
  distance2D(userA, userB);

const findNearbyUsers = async (
  roomId,
  x,
  y,
  excludeSocketId
) => {
  const participants = await getRoomUsers(roomId);

  const currentUser = {
    id: excludeSocketId,
    roomId,
    x,
    y,
  };

  return filterNearbyUsers(
    participants,
    currentUser,
    PROXIMITY_RADIUS
  );
};

const updateProximityForUser = async (user) => {
  const nearbyUsers = await findNearbyUsers(
    user.roomId,
    user.x,
    user.y,
    user.id
  );

  // Each socket automatically belongs to its own ID room.
  // The Redis adapter routes this event across instances.
  io.to(user.id).emit('proximity:update', {
    radius: PROXIMITY_RADIUS,
    nearbyUserIds: nearbyUsers.map(
      (nearbyUser) => nearbyUser.id
    ),
  });
};

const broadcastRoomProximity = async (roomId) => {
  const participants = await getRoomUsers(roomId);

  await Promise.all(
    participants.map(async (user) => {
      try {
        await updateProximityForUser(user);
      } catch (error) {
        console.error(
          'Proximity update failed:',
          error.message
        );
      }
    })
  );
};

// --------------------------------------------------
// HTTP API ROUTES
// --------------------------------------------------

app.get('/api/health', async (_req, res) => {
  try {
    const redis = presenceRedis();

    res.json({
      ok: true,
      service: 'ProxiSpeak',
      connectedUsers: users.size,
      sharedPresence: Boolean(redis),
      persistence: Boolean(positionsCollection),
      redisAdapter: Boolean(redisClients),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get('/api/ready', (_req, res) => {
  if (process.env.MONGODB_URI && !positionsCollection) {
    return res.status(503).json({
      ready: false,
      reason: 'MongoDB unavailable',
    });
  }

  if (process.env.REDIS_URL && !redisClients) {
    return res.status(503).json({
      ready: false,
      reason: 'Redis unavailable',
    });
  }

  res.json({ ready: true });
});

app.get('/api/users', async (req, res) => {
  try {
    const roomId = String(
      req.query.roomId || 'main-office'
    ).slice(0, 40);

    const participants = await getRoomUsers(roomId);

    res.json(participants);
  } catch (error) {
    console.error('Room users lookup failed:', error.message);

    res.status(500).json({
      error: 'Could not retrieve room users',
    });
  }
});

// --------------------------------------------------
// ROOM LAYOUT API
// --------------------------------------------------

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

  // ------------------------------------------------
  // JOIN OFFICE
  // ------------------------------------------------

  socket.on('office:join', async (payload = {}) => {
    try {
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

      const safeName =
        String(payload.name || 'Guest')
          .trim()
          .slice(0, 24) || 'Guest';

      const safeRoom =
        String(payload.roomId || 'main-office')
          .trim()
          .slice(0, 40) || 'main-office';

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

      // Save local reference for this server.
      users.set(socket.id, user);

      socket.data.roomId = safeRoom;

      // Join Socket.IO room.
      socket.join(safeRoom);

      // Save shared presence in Redis.
      await saveSharedUser(user);

      // Persist position in MongoDB.
      if (positionsCollection) {
        await positionsCollection.updateOne(
          {
            roomId: safeRoom,
            socketId: socket.id,
          },
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
      }

      // Send existing shared users to the joining client.
      const participants = await getRoomUsers(safeRoom);

      socket.emit('office:joined', {
        selfId: socket.id,
        users: participants,
      });

      // Notify users on both backend instances.
      socket.to(safeRoom).emit('user:joined', user);

      await broadcastRoomUsers(safeRoom);
      await broadcastRoomProximity(safeRoom);

      console.log(
        `User ${safeName} joined room ${safeRoom} on port ${PORT}`
      );

    } catch (error) {
      console.error('Office join failed:', error.message);

      users.delete(socket.id);
      socket.leave(socket.data.roomId);

      socket.emit('office:join:error', {
        message: 'Could not join office. Please try again.',
      });
    }
  });

  // ------------------------------------------------
  // MANUAL PRESENCE STATUS
  // ------------------------------------------------

  socket.on('presence:update', async (payload = {}) => {
    try {
      const user = await getSharedUser(socket.id);

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

      await updateSharedUser(user);

      if (positionsCollection) {
        await positionsCollection.updateOne(
          {
            roomId: user.roomId,
            socketId: socket.id,
          },
          {
            $set: {
              status: user.status,
              manualStatus: user.manualStatus,
              updatedAt: new Date(),
            },
          }
        );
      }

      await broadcastRoomUsers(user.roomId);
    } catch (error) {
      console.error('Presence update failed:', error.message);
    }
  });

  // ------------------------------------------------
  // AVATAR MOVEMENT
  // ------------------------------------------------

  socket.on('avatar:move', async (payload) => {
    try {
      if (
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload)
      ) {
        return;
      }

      const user = await getSharedUser(socket.id);

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

      // Refresh shared Redis presence and expiry.
      await updateSharedUser(user);

      // Persist position in MongoDB.
      if (positionsCollection) {
        await positionsCollection.updateOne(
          {
            roomId: user.roomId,
            socketId: socket.id,
          },
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
      }

      // Broadcast movement across both backend instances.
      io.to(user.roomId).emit('avatar:moved', user);

      if (previousStatus !== user.status) {
        await broadcastRoomUsers(user.roomId);
      }

      await broadcastRoomProximity(user.roomId);

    } catch (error) {
      console.error('Avatar movement failed:', error.message);
    }
  });

  // ------------------------------------------------
  // WEBRTC AUDIO SIGNALING
  // ------------------------------------------------

  socket.on('audio:signal', async (payload = {}) => {
    try {
      if (
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload)
      ) {
        return;
      }

      const { targetId, signal } = payload;

      if (
        typeof targetId !== 'string' ||
        !targetId ||
        !signal
      ) {
        return;
      }

      // Read sender and target from shared Redis presence.
      const sender = await getSharedUser(socket.id);
      const target = await getSharedUser(targetId);

      if (!sender || !target) return;

      // Both users must belong to the same room.
      if (sender.roomId !== target.roomId) return;

      const coordinates = [
        sender.x,
        sender.y,
        target.x,
        target.y,
      ];

      if (!coordinates.every(Number.isFinite)) {
        return;
      }

      const distance = getDistance(sender, target);

      if (distance > PROXIMITY_RADIUS) {
        return;
      }

      // Redis adapter routes this to the target socket,
      // even if it belongs to another backend instance.
      io.to(targetId).emit('audio:signal', {
        fromId: socket.id,
        signal,
      });

    } catch (error) {
      console.error('Audio signaling failed:', error.message);
    }
  });

  // ------------------------------------------------
  // DISCONNECT AND CLEANUP
  // ------------------------------------------------

  socket.on('disconnect', async () => {
    try {
      const user = users.get(socket.id);

      if (!user) return;

      users.delete(socket.id);

      const redis = presenceRedis();

      if (redis) {
        await redis.del(userPresenceKey(socket.id));

        await redis.sRem(
          roomPresenceKey(user.roomId),
          socket.id
        );

        await redis.sRem(
          instanceUsersKey(INSTANCE_ID),
          socket.id
        );
      }

      if (positionsCollection) {
        await positionsCollection.deleteOne({
          roomId: user.roomId,
          socketId: socket.id,
        });
      }

      // Notify users across both backend instances.
      io.to(user.roomId).emit('user:left', {
        id: socket.id,
      });

      await broadcastRoomUsers(user.roomId);
      await broadcastRoomProximity(user.roomId);

      console.log(
        `User ${user.name} disconnected from ${user.roomId}`
      );

    } catch (error) {
      console.error('Disconnect cleanup failed:', error.message);
    }
  });

});


// --------------------------------------------------
// AUTOMATIC PRESENCE REFRESH
// --------------------------------------------------

const presenceTimer = setInterval(async () => {
  const now = Date.now();
  const changedRooms = new Set();

  for (const user of users.values()) {
    try {
      const previousStatus = user.status;

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

      user.status = nextStatus;

      // Refresh Redis TTL and shared user information.
      await updateSharedUser(user);

      if (previousStatus !== nextStatus) {
        changedRooms.add(user.roomId);

        if (positionsCollection) {
          await positionsCollection.updateOne(
            {
              roomId: user.roomId,
              socketId: user.id,
            },
            {
              $set: {
                status: user.status,
                updatedAt: new Date(),
              },
            }
          );
        }
      }
    } catch (error) {
      console.error(
        'Automatic presence refresh failed:',
        error.message
      );
    }
  }

  // Notify clients in every affected room.
  for (const roomId of changedRooms) {
    try {
      await broadcastRoomUsers(roomId);
    } catch (error) {
      console.error(
        'Presence broadcast failed:',
        error.message
      );
    }
  }
}, PRESENCE_REFRESH_MS);

presenceTimer.unref();

const instanceHeartbeatTimer = setInterval(() => {
  writeInstanceHeartbeat().catch((error) => {
    console.error('Instance heartbeat failed:', error.message);
  });
}, INSTANCE_HEARTBEAT_INTERVAL_MS);

instanceHeartbeatTimer.unref();

const instanceCleanupTimer = setInterval(() => {
  recoverFailedInstances().catch((error) => {
    console.error('Instance recovery task failed:', error.message);
  });
}, INSTANCE_CLEANUP_INTERVAL_MS);

instanceCleanupTimer.unref();

// Run a recovery scan after startup.
if (presenceRedis()) {
  recoverFailedInstances().catch((error) => {
    console.error('Startup recovery scan failed:', error.message);
  });
}

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

httpServer.listen(PORT, () => {
  console.log(
    `ProxiSpeak server running at http://localhost:${PORT}`
  );

  console.log('Backend instance ID:', INSTANCE_ID);

  console.log(
    `MongoDB persistence: ${Boolean(positionsCollection)}`
  );

  console.log(
    `Redis shared presence: ${Boolean(redisClients)}`
  );

  console.log(
    `MongoDB proximity radius: ${PROXIMITY_RADIUS} pixels`
  );

  console.log(
    'Shared presence synchronization initialized'
  );
});

// --------------------------------------------------
// GRACEFUL SHUTDOWN
// --------------------------------------------------

let isShuttingDown = false;

const shutdown = async () => {
  if (isShuttingDown) return;

  isShuttingDown = true;

  console.log('Shutting down ProxiSpeak server...');

  clearInterval(presenceTimer);
  clearInterval(instanceHeartbeatTimer);
  clearInterval(instanceCleanupTimer);

  const redis = presenceRedis();
  const affectedRooms = new Set();
  const removedUsers = [];

  // Remove only records owned by this backend instance.
  if (redis) {
    for (const user of users.values()) {
      try {
        const current = await getSharedUser(user.id);

        if (current?.instanceId === INSTANCE_ID) {
          await redis.del(userPresenceKey(user.id));
          await redis.sRem(roomPresenceKey(user.roomId), user.id);
          affectedRooms.add(user.roomId);
          removedUsers.push(user);

          if (positionsCollection) {
            await positionsCollection.deleteOne({
              roomId: user.roomId,
              socketId: user.id,
            });
          }
        }
      } catch (error) {
        console.error(
          'Shutdown presence cleanup failed:',
          error.message
        );
      }
    }

    await redis.del(instanceUsersKey(INSTANCE_ID));
    await redis.del(instanceHeartbeatKey(INSTANCE_ID));

    for (const user of removedUsers) {
      io.to(user.roomId).emit('user:left', {
        id: user.id,
      });
    }

    for (const roomId of affectedRooms) {
      try {
        await broadcastRoomUsers(roomId);
        await broadcastRoomProximity(roomId);
      } catch (error) {
        console.error(
          'Shutdown room broadcast failed:',
          error.message
        );
      }
    }
  } else if (positionsCollection) {
    for (const user of users.values()) {
      await positionsCollection.deleteOne({
        roomId: user.roomId,
        socketId: user.id,
      }).catch(() => {});
    }
  }

  // Close Socket.IO and the underlying HTTP server.
  await new Promise((resolve) => {
    io.close(() => resolve());
  });

  if (redisClients) {
    await Promise.allSettled(
      redisClients.map((client) => client.quit())
    );
  }

  if (mongoClient) {
    await mongoClient.close().catch((error) => {
      console.error(
        'MongoDB shutdown error:',
        error.message
      );
    });
  }

  console.log('ProxiSpeak server shut down successfully');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
