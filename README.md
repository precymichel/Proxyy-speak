# ProxiSpeak — Virtual Office Prototype

A React + Node.js + Socket.IO prototype for the Infotact ProxiSpeak project brief.

## Implemented
- 2D virtual office UI with movable avatars (WASD / arrow keys)
- Multi-browser real-time presence and movement through Socket.IO
- Rooms, participant list, proximity distance calculations
- WebRTC offer/answer/ICE signaling relay and peer connection foundation
- Microphone permission and remote audio element handling
- Distance-based audio attenuation for received audio
- Optional MongoDB persistence for participant positions and room layout API
- Health endpoint and basic API error handling

## Stack
- React 18 + Vite
- Node.js + Express
- Socket.IO
- WebRTC + Web Audio-adjacent browser audio controls
- MongoDB Node driver (optional)

## Run locally

Requirements: Node.js 20+ and npm. MongoDB is optional for local demo.

### Server
```bash
cd server
cp .env.example .env
npm install
npm run dev
```

### Client (second terminal)
```bash
cd client
cp .env.example .env
npm install
npm run dev
```
Open `http://localhost:5173` and join a room. Open another browser window (or another device on the same network with suitable Vite/server host configuration) and join the same room with a different name.

## MongoDB (optional)
Set `MONGODB_URI` in `server/.env`. The server creates a `proxispeak` database, `positions` and `rooms` collections, a compound index for room/socket lookup, and a 2dsphere index on position points. Room layout persistence endpoints:
- `GET /api/rooms/:roomId`
- `PUT /api/rooms/:roomId` with JSON body `{ "layout": { ... } }`

## WebRTC / audio notes
- Microphone access requires user permission and usually `localhost` or HTTPS.
- The demo uses Google's public STUN server. Some networks require a TURN server for peer connectivity.
- Peer-to-peer audio and distance attenuation are an educational prototype. Test in two browsers with microphone permission; browser autoplay rules may require a click.
- The app attenuates received audio by avatar distance, but it does not yet implement robust sound occlusion from furniture or advanced stereo 3D panning.
- The server relays WebRTC signaling only; media flows peer-to-peer.

## Important scope notes
The internship brief also calls for Redis Pub/Sub multi-instance scaling, 50+ concurrent-user/load testing, sub-20ms geospatial audit, 60 FPS profiling, persistent furniture/obstacles that block sound, and production hardening. Those require separate implementation and measured testing; this project does not claim those requirements are already verified. The prototype should be reviewed with your internship supervisor and extended to match their acceptance criteria.

## Security / production checklist
- Add authentication and authorization before public deployment.
- Add rate limits and input validation appropriate to a public service.
- Configure HTTPS and a TURN service for reliable WebRTC.
- Do not expose MongoDB credentials in client code.
- Add automated tests and load-test evidence before claiming performance targets.


## Container deployment (local production-like stack)

Docker and Docker Compose are required:
```bash
docker compose up --build
```
Open `http://localhost:8080`. The compose file starts the web client, API/socket server, MongoDB, and Redis. For a real public deployment, replace local origins with your HTTPS domain, configure TLS/reverse proxy, set secrets through your hosting provider, and configure TURN credentials.

## Hardening added in this version
- Helmet security headers and API rate limiting
- Health and readiness endpoints
- Optional Socket.IO Redis adapter for cross-instance event fan-out
- Dockerfiles and Compose stack
- Spatial math unit tests (`cd server && npm install && npm test`)
- Git ignore rules and deployment notes

## Production acceptance checklist (must be completed before calling this production-ready)
- Implement and test authentication, authorization, room membership controls, and abuse protection.
- Configure HTTPS and a production TURN server; validate WebRTC connectivity across NATs/mobile networks.
- Persist and restore user-defined office layouts with an authorized admin/editor workflow.
- Implement furniture collision/occlusion and true stereo spatial panning if required by acceptance criteria.
- Move live presence into a shared store if horizontally scaling the Socket.IO server; Redis adapter distributes Socket.IO events but does not share this process-local user map.
- Run 50+ participant load tests and document latency, memory, CPU, and rendering frame-rate measurements.
- Add end-to-end tests, dependency scanning, backups, monitoring, logs, and incident procedures.
- Update CORS and `VITE_SERVER_URL` to match your actual HTTPS deployment domain.

This repository is a production-oriented project scaffold, not a claim that production readiness or the assignment's performance targets have been independently verified. Audio and deployment must be tested in the target environment before submission.
