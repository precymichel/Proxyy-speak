# ProxiSpeak Deployment Checklist

## Local verification
- [ ] `cd server && npm install && npm test`
- [ ] `npm run dev` in server terminal
- [ ] `cd client && npm install && npm run build`
- [ ] `npm run dev` in client terminal
- [ ] Join same room from two browser sessions
- [ ] Confirm both avatars move in real time
- [ ] Grant microphone permission in both sessions and test audio
- [ ] Confirm proximity volume changes while moving avatars
- [ ] Test server restart and MongoDB reconnect behavior

## Docker verification
- [ ] Install Docker Desktop
- [ ] Run `docker compose up --build`
- [ ] Visit `http://localhost:8080`
- [ ] Check API health endpoint at `http://localhost:4000/api/health`
- [ ] Review container logs for database and Redis connection errors

## Before public production deployment
- [ ] HTTPS/TLS configured
- [ ] Real TURN server credentials configured securely
- [ ] Auth and room access controls implemented
- [ ] CORS origin updated to the production domain
- [ ] Load test and report 50+ concurrent participant behavior
- [ ] Backups, monitoring, and error reporting configured
- [ ] Confirm acceptance criteria with internship supervisor
