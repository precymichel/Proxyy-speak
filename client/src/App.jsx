
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { io } from 'socket.io-client';

const SERVER_URL =
  import.meta.env.VITE_SERVER_URL || 'http://localhost:4000';

const DISTANCE_LIMIT = 100;
const AUDIO_RANGE = 100;

function distance(a, b) {
  return Math.round(Math.hypot(a.x - b.x, a.y - b.y));
}

function normalizePresence(value) {
  return value === 'away' || value === 'online' ? value : 'auto';
}

export default function App() {
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState('main-office');
  const [joined, setJoined] = useState(false);
  const [selfId, setSelfId] = useState('');
  const [users, setUsers] = useState([]);
  const [connected, setConnected] = useState(false);
  const [micEnabled, setMicEnabled] = useState(false);
  const [micReady, setMicReady] = useState(false);
  const [presenceStatus, setPresenceStatus] = useState('auto');
  const [status, setStatus] = useState('Join the office to get started.');

  const socketRef = useRef(null);
  const selfRef = useRef(null);
  const keysRef = useRef({});
  const streamRef = useRef(null);
  const peersRef = useRef(new Map());
  const audioElsRef = useRef(new Map());
  const usersRef = useRef([]);
  const selfIdRef = useRef('');
  const roomRef = useRef('main-office');
  const presenceRef = useRef('auto');
  const pendingIceRef = useRef(new Map());
  const makingOfferRef = useRef(new Set());

  useEffect(() => {
    usersRef.current = users;
  }, [users]);

  useEffect(() => {
    selfIdRef.current = selfId;
  }, [selfId]);

  useEffect(() => {
    roomRef.current = roomId;
  }, [roomId]);

  useEffect(() => {
    presenceRef.current = presenceStatus;
  }, [presenceStatus]);

  const updatePresence = useCallback((nextStatus) => {
    const validStatus = normalizePresence(nextStatus);
    setPresenceStatus(validStatus);
    presenceRef.current = validStatus;

    if (socketRef.current?.connected) {
      socketRef.current.emit('presence:update', {
        status: validStatus,
      });
    }
  }, []);

  const sendSignal = useCallback((targetId, signal) => {
    socketRef.current?.emit('audio:signal', {
      targetId,
      signal,
    });
  }, []);

  const closePeer = useCallback((peerId) => {
    const pc = peersRef.current.get(peerId);

    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.close();
    }

    peersRef.current.delete(peerId);
    pendingIceRef.current.delete(peerId);
    makingOfferRef.current.delete(peerId);

    const audio = audioElsRef.current.get(peerId);

    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    }

    audioElsRef.current.delete(peerId);
  }, []);

  const getPeer = useCallback(
    (peerId) => {
      let pc = peersRef.current.get(peerId);
      if (pc) return pc;

      pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
        ],
      });

      pendingIceRef.current.set(peerId, []);

      const localStream = streamRef.current;

      if (localStream) {
        localStream.getAudioTracks().forEach((track) => {
          pc.addTrack(track, localStream);
        });
      }

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) {
          sendSignal(peerId, {
            type: 'ice',
            candidate: candidate.toJSON(),
          });
        }
      };

      pc.ontrack = async ({ streams }) => {
        const remoteStream = streams?.[0];
        if (!remoteStream) return;

        let audio = audioElsRef.current.get(peerId);

        if (!audio) {
          audio = document.createElement('audio');
          audio.autoplay = true;
          audio.playsInline = true;
          audio.dataset.peerId = peerId;
          document.body.appendChild(audio);
          audioElsRef.current.set(peerId, audio);
        }

        audio.srcObject = remoteStream;
        audio.volume = 0.8;

        try {
          await audio.play();
        } catch {
          setStatus(
            'Remote audio is ready. Click the page if playback is blocked.',
          );
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setStatus('Voice connection established.');
        } else if (pc.connectionState === 'failed') {
          setStatus(
            'Voice connection failed. STUN-only audio may not work on this network.',
          );
        } else if (pc.connectionState === 'disconnected') {
          setStatus('Voice connection interrupted. Waiting for recovery...');
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed') {
          setStatus(
            'ICE connection failed. This network may require a TURN relay.',
          );
        }
      };

      peersRef.current.set(peerId, pc);
      return pc;
    },
    [sendSignal],
  );

  const flushPendingIce = useCallback(async (peerId, pc) => {
    const queued = pendingIceRef.current.get(peerId) || [];
    pendingIceRef.current.set(peerId, []);

    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.warn('Could not apply queued ICE candidate:', error);
      }
    }
  }, []);

  const startPeerCall = useCallback(
    async (peerId) => {
      if (!streamRef.current || !selfIdRef.current) return;
      if (selfIdRef.current.localeCompare(peerId) > 0) return;

      const pc = getPeer(peerId);

      if (
        pc.signalingState !== 'stable' ||
        makingOfferRef.current.has(peerId)
      ) {
        return;
      }

      try {
        makingOfferRef.current.add(peerId);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        sendSignal(peerId, {
          type: 'description',
          description: pc.localDescription,
        });
      } catch (error) {
        console.error('Could not create audio offer:', error);
        setStatus('Could not start a voice connection.');
      } finally {
        makingOfferRef.current.delete(peerId);
      }
    },
    [getPeer, sendSignal],
  );

  async function handleSignal(fromId, signal) {
    if (!fromId || !signal) return;

    // Only accept audio signaling from a teammate in this room and within 100px.
    const currentUsers = usersRef.current;
    const currentMe = currentUsers.find(
      (user) => user.id === selfIdRef.current
    );
    const peer = currentUsers.find((user) => user.id === fromId);

    const sameRoom =
      peer && (!peer.roomId || peer.roomId === roomRef.current);
    const withinRange =
      currentMe &&
      peer &&
      distance(currentMe, peer) <= DISTANCE_LIMIT;

    if (!sameRoom || !withinRange) {
      closePeer(fromId);
      return;
    }

    try {
      const pc = getPeer(fromId);

      if (signal.type === 'ice' && signal.candidate) {
        if (!pc.remoteDescription) {
          const queued = pendingIceRef.current.get(fromId) || [];
          queued.push(signal.candidate);
          pendingIceRef.current.set(fromId, queued);
        } else {
          await pc.addIceCandidate(
            new RTCIceCandidate(signal.candidate),
          );
        }
        return;
      }

      if (
        signal.type !== 'description' ||
        !signal.description
      ) {
        return;
      }

      const description = signal.description;
      const polite = selfIdRef.current.localeCompare(fromId) > 0;

      const offerCollision =
        description.type === 'offer' &&
        (makingOfferRef.current.has(fromId) ||
          pc.signalingState !== 'stable');

      if (offerCollision && !polite) return;

      if (offerCollision && polite) {
        await pc.setLocalDescription({ type: 'rollback' });
      }

      await pc.setRemoteDescription(
        new RTCSessionDescription(description),
      );

      await flushPendingIce(fromId, pc);

      if (description.type === 'offer') {
        if (!streamRef.current) return;

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        sendSignal(fromId, {
          type: 'description',
          description: pc.localDescription,
        });
      }
    } catch (error) {
      console.error('WebRTC signaling error:', error);
      setStatus('Audio negotiation failed. Try toggling your microphone.');
    }
  }

  const me = users.find((user) => user.id === selfId);

  const nearby = useMemo(
    () =>
      me
        ? users.filter(
            (user) =>
              user.id !== selfId &&
              distance(me, user) <= DISTANCE_LIMIT,
          )
        : [],
    [users, selfId, me],
  );

  const joinOffice = (event) => {
    event.preventDefault();

    // Clean up any previous session before creating another.
    socketRef.current?.disconnect();
    peersRef.current.forEach((pc) => pc.close());
    peersRef.current.clear();
    pendingIceRef.current.clear();
    makingOfferRef.current.clear();

    const requestedName = name.trim() || 'Guest';
    const requestedRoom = roomId.trim() || 'main-office';

    roomRef.current = requestedRoom;
    setRoomId(requestedRoom);

    const socket = io(SERVER_URL);
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      setStatus('Connected. Joining your office...');

      socket.emit('office:join', {
        name: requestedName,
        roomId: requestedRoom,
      });
    });

    socket.on('connect_error', () => {
      setConnected(false);
      setStatus('Cannot reach the server. Start the server and try again.');
    });

    socket.on('disconnect', () => {
      setConnected(false);
      setStatus('Connection lost. Trying to reconnect...');
    });

    socket.on('office:join:error', ({ message } = {}) => {
      setStatus(message || 'Could not join the office. Please try again.');
    });

    socket.on(
      'office:joined',
      ({ selfId: id, users: initialUsers } = {}) => {
        const roster = Array.isArray(initialUsers) ? initialUsers : [];

        setSelfId(id || '');
        selfIdRef.current = id || '';
        setUsers(roster);
        usersRef.current = roster;

        selfRef.current =
          roster.find((user) => user.id === id) || null;

        setJoined(true);

        socket.emit('presence:update', {
          status: presenceRef.current,
        });

        setStatus(
          `Joined ${requestedRoom}. ${roster.length} participant(s) currently in this room.`,
        );
      },
    );

    socket.on('user:joined', (user) => {
      if (!user?.id) return;

      setUsers((current) => {
        const exists = current.some((item) => item.id === user.id);

        return exists
          ? current.map((item) =>
              item.id === user.id ? { ...item, ...user } : item,
            )
          : [...current, user];
      });

      setStatus(`${user.name || 'A participant'} joined the office.`);
    });

    socket.on('avatar:moved', (user) => {
      if (!user?.id) return;

      setUsers((current) => {
        const exists = current.some((item) => item.id === user.id);

        return exists
          ? current.map((item) =>
              item.id === user.id ? { ...item, ...user } : item,
            )
          : [...current, user];
      });

      if (user.id === socket.id) selfRef.current = user;
    });

    socket.on('users:update', (nextUsers) => {
      const roster = Array.isArray(nextUsers) ? nextUsers : [];

      setUsers(roster);
      usersRef.current = roster;

      selfRef.current =
        roster.find((user) => user.id === socket.id) || null;
    });

    socket.on('user:left', ({ id } = {}) => {
      if (!id) return;

      setUsers((current) =>
        current.filter((user) => user.id !== id),
      );

      closePeer(id);
      setStatus('A participant left the office.');
    });

    socket.on('audio:signal', ({ fromId, signal } = {}) => {
      if (fromId && signal) {
        handleSignal(fromId, signal);
      }
    });
  };

  const move = useCallback((dx, dy) => {
    const socket = socketRef.current;
    const current = selfRef.current;

    if (!socket || !current) return;

    const next = {
      ...current,
      x: Math.max(24, Math.min(776, current.x + dx)),
      y: Math.max(24, Math.min(476, current.y + dy)),
    };

    selfRef.current = next;

    setUsers((old) =>
      old.map((user) => (user.id === next.id ? next : user)),
    );

    socket.emit('avatar:move', {
      x: next.x,
      y: next.y,
    });
  }, []);

  // Keyboard movement.
  useEffect(() => {
    if (!joined) return;

    const down = (event) => {
      const key = event.key.toLowerCase();

      if (
        [
          'arrowup',
          'arrowdown',
          'arrowleft',
          'arrowright',
          'w',
          'a',
          's',
          'd',
        ].includes(key)
      ) {
        event.preventDefault();
      }

      keysRef.current[key] = true;
    };

    const up = (event) => {
      keysRef.current[event.key.toLowerCase()] = false;
    };

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);

    let frame;
    let last = 0;

    const tick = (time) => {
      if (time - last > 65) {
        const keys = keysRef.current;

        const dx =
          (keys.arrowright || keys.d ? 1 : 0) -
          (keys.arrowleft || keys.a ? 1 : 0);

        const dy =
          (keys.arrowdown || keys.s ? 1 : 0) -
          (keys.arrowup || keys.w ? 1 : 0);

        if (dx || dy) move(dx * 8, dy * 8);
        last = time;
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      cancelAnimationFrame(frame);
    };
  }, [joined, move]);

  // Spatial volume based on avatar distance.
  useEffect(() => {
    if (!me) return;

    users.forEach((user) => {
      if (user.id === selfId) return;

      const audio = audioElsRef.current.get(user.id);
      if (!audio) return;

      const d = distance(me, user);
      audio.volume = Math.max(0, Math.min(1, 1 - d / AUDIO_RANGE));
    });
  }, [users, selfId, me]);

  // Close established audio connections as soon as a teammate leaves 100px range.
  useEffect(() => {
    if (!joined || !selfId || !me) return;

    for (const peerId of peersRef.current.keys()) {
      const peer = users.find((user) => user.id === peerId);
      const sameRoom =
        peer && (!peer.roomId || peer.roomId === roomId);
      const withinRange =
        peer && distance(me, peer) <= DISTANCE_LIMIT;

      if (!sameRoom || !withinRange) {
        closePeer(peerId);
      }
    }
  }, [joined, selfId, users, roomId, me, closePeer]);

  // Start calls with nearby participants when the mic is enabled.
  useEffect(() => {
    if (!joined || !micEnabled || !selfId || !me) return;

    users
      .filter(
        (user) =>
          user.id !== selfId &&
          (!user.roomId || user.roomId === roomId) &&
          distance(me, user) <= DISTANCE_LIMIT,
      )
      .forEach((user) => startPeerCall(user.id));
  }, [
    joined,
    micEnabled,
    selfId,
    users,
    roomId,
    me,
    startPeerCall,
  ]);

  async function enableMicrophone() {
    // If a microphone stream already exists, toggle mute/unmute without
    // stopping the track or requesting permission again.
    if (streamRef.current) {
      const tracks = streamRef.current.getAudioTracks();

      if (tracks.length === 0) {
        setStatus(
          'No microphone audio track is available. Leave and rejoin the office.',
        );
        return;
      }

      const shouldEnable = tracks.some((track) => !track.enabled);

      tracks.forEach((track) => {
        track.enabled = shouldEnable;
      });

      setMicReady(true);
      setMicEnabled(shouldEnable);
      setStatus(
        shouldEnable
          ? 'Microphone unmuted. You can speak now.'
          : 'Microphone muted. Click Unmute to speak again.',
      );
      return;
    }

    // First activation: request microphone permission.
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone access requires localhost or HTTPS.');
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      const audioTracks = stream.getAudioTracks();

      if (audioTracks.length === 0) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error('No microphone audio track was detected.');
      }

      streamRef.current = stream;

      // Start unmuted. Muting later only toggles track.enabled.
      audioTracks.forEach((track) => {
        track.enabled = true;
      });

      setMicReady(true);
      setMicEnabled(true);

      // Add the microphone to connections that were created before permission.
      for (const pc of peersRef.current.values()) {
        const track = audioTracks[0];
        const sender = pc
          .getSenders()
          .find((item) => item.track?.kind === 'audio');

        if (sender) {
          await sender.replaceTrack(track);
        } else {
          pc.addTrack(track, stream);
        }
      }

      setStatus('Microphone enabled. Connecting to nearby teammates...');

      // Start calls with teammates who are already nearby.
      const currentUsers = usersRef.current;
      const currentMe = currentUsers.find(
        (user) => user.id === selfIdRef.current,
      );

      if (currentMe) {
        currentUsers
          .filter(
            (user) =>
              user.id !== selfIdRef.current &&
              (!user.roomId || user.roomId === roomRef.current) &&
              distance(currentMe, user) <= DISTANCE_LIMIT,
          )
          .forEach((user) => startPeerCall(user.id));
      }
    } catch (error) {
      console.error('Microphone access failed:', error);
      setStatus(
        `Microphone unavailable: ${error.message}. Allow microphone access and use localhost or HTTPS.`,
      );
    }
  }

  // Leave the office and release local media and remote audio.
  const leaveOffice = useCallback(() => {
    socketRef.current?.disconnect();
    socketRef.current = null;

    peersRef.current.forEach((pc) => pc.close());
    peersRef.current.clear();
    pendingIceRef.current.clear();
    makingOfferRef.current.clear();

    audioElsRef.current.forEach((audio) => {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    });
    audioElsRef.current.clear();

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    selfRef.current = null;
    selfIdRef.current = '';
    usersRef.current = [];
    keysRef.current = {};

    setMicEnabled(false);
    setMicReady(false);
    setConnected(false);
    setJoined(false);
    setSelfId('');
    setUsers([]);
    setStatus('You left the office.');
  }, []);

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();

      streamRef.current?.getTracks().forEach((track) => track.stop());

      peersRef.current.forEach((pc) => pc.close());

      audioElsRef.current.forEach((audio) => {
        audio.pause();
        audio.srcObject = null;
        audio.remove();
      });

      audioElsRef.current.clear();
      peersRef.current.clear();
    };
  }, []);

  // Join screen.
  if (!joined) {
    return (
      <main className="join-screen join-split-screen">
        <section className="join-welcome-panel" aria-label="Welcome to ProxiSpeak">
          <div className="join-brand-lockup">
            <div className="brand-mark">PS</div>
            <div>
              <div className="join-brand-name">Proxi<span>Speak</span></div>
              <p>Virtual Office. Real Conversations.</p>
            </div>
          </div>

          <div className="join-welcome-copy">
            <p className="join-kicker">YOUR TEAM, CLOSER</p>
            <h1>Work Together.<br />Feel <span>Closer.</span></h1>
            <p className="join-description">
              Move around, talk naturally, and collaborate in a virtual
              space — just like a real office.
            </p>
            <ul className="join-feature-list">
              <li><span className="join-feature-icon">◉</span><span>Real-time spatial audio</span></li>
              <li><span className="join-feature-icon">▦</span><span>Interactive office spaces</span></li>
              <li><span className="join-feature-icon">↗</span><span>More natural collaboration</span></li>
            </ul>
          </div>

          <p className="join-welcome-footer">A shared space for better teamwork.</p>
        </section>

        <section className="join-form-panel" aria-label="Join your virtual office">
          <div className="join-card">
            <div className="join-form-brand">
              <div className="brand-mark">PS</div>
              <div>
                <div className="join-brand-name">Proxi<span>Speak</span></div>
                <p>Virtual Office. Real Conversations.</p>
              </div>
            </div>

            <p className="eyebrow">JOIN YOUR SPACE</p>
            <h2>Welcome to Proxi<span>Speak</span></h2>
            <p className="muted">
              Enter your details to join the virtual office and start
              connecting with your team.
            </p>

            <form onSubmit={joinOffice}>
              <label>
                Your name
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Enter your name"
                  maxLength={24}
                  autoComplete="name"
                />
              </label>

              <label>
                Office room
                <input
                  value={roomId}
                  onChange={(event) => setRoomId(event.target.value)}
                  placeholder="main-office"
                  maxLength={40}
                />
              </label>

              <button className="primary join-submit" type="submit">
                <span>Join Office</span><span aria-hidden="true">→</span>
              </button>
            </form>

            <div className="join-ready-status">
              <span className="join-ready-dot" />
              <div>
                <strong>Ready to connect</strong>
                <p>Real-time audio · Move freely · Work together</p>
              </div>
            </div>

            <p className="status join-form-status" role="status">{status}</p>
          </div>
        </section>
      </main>
    );
  }

  // Main virtual office.
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark small">PS</div>
          <div>
            <strong>ProxiSpeak</strong>
            <span>Virtual workspace</span>
          </div>
        </div>

        <div className="top-actions">
          <span className={`connection ${connected ? 'online' : ''}`}>
            <i />{connected ? 'Connected' : 'Connecting'}
          </span>

          <label className="presence-control">
            <span>My status</span>
            <select
              value={presenceStatus}
              onChange={(event) => updatePresence(event.target.value)}
              disabled={!connected}
              aria-label="Choose your presence status"
              title="Choose your presence status"
            >
              <option value="auto">Auto</option>
              <option value="online">Online</option>
              <option value="away">Away</option>
            </select>
          </label>

          <button className="secondary" onClick={leaveOffice}>
            Leave office
          </button>
        </div>
      </header>

      <div className="content">
        <section className="welcome-row">
          <div>
            <p className="eyebrow">YOUR WORKSPACE</p>
            <h1>{roomId}</h1>
            <p className="muted">
              Move around the office to connect with teammates nearby.
            </p>
          </div>
          <div className="keyboard-hint">
            <span>⌨</span> Move with <b>W A S D</b> or <b>↑ ↓ ← →</b>
          </div>
        </section>

        <div className="main-grid">
          <section className="office-card">
            <div className="card-heading">
              <div>
                <h2>Office floor</h2>
                <p>Live participant positions</p>
              </div>
              <span className="live-pill"><i /> LIVE</span>
            </div>

            <div className="office-map">
              <div className="room room-one">
                <span>COLLAB ZONE</span><div className="couch" /><div className="plant">♣</div>
              </div>
              <div className="room room-two">
                <span>FOCUS AREA</span>
                <div className="desk"><i /><i /></div>
                <div className="desk second"><i /><i /></div>
              </div>
              <div className="room room-three">
                <span>MEETING ROOM</span><div className="meeting-table" />
              </div>
              <div className="room room-four">
                <span>LOUNGE</span><div className="round-table" />
              </div>

              {users.map((user) => {
                const d = me && user.id !== selfId ? distance(me, user) : null;
                const close = d !== null && d <= DISTANCE_LIMIT;

                return (
                  <div
                    key={user.id}
                    className={`avatar ${user.id === selfId ? 'self' : ''} ${close ? 'nearby' : ''}`}
                    style={{
                      left: `${(user.x / 800) * 100}%`,
                      top: `${(user.y / 500) * 100}%`,
                    }}
                    title={`${user.name}${d !== null ? ` · ${d}px away` : ''}`}
                  >
                    <div className="avatar-face">{user.name.slice(0, 1).toUpperCase()}</div>
                    <span>{user.name}{user.id === selfId ? ' (you)' : ''}</span>
                  </div>
                );
              })}

              {!users.length && <div className="empty-map">Waiting for teammates to join…</div>}
            </div>

            <div className="map-footer">
              <span><i className="legend-self" /> You</span>
              <span><i className="legend-near" /> Nearby teammate</span>
              <span><i className="legend-other" /> Other teammate</span>
            </div>
          </section>

          <aside className="side-column">
            <section className="panel">
              <div className="panel-heading">
                <h2>People here</h2><span className="count">{users.length}</span>
              </div>

              <div className="people-list">
                {users.map((user) => {
                  const d = me && user.id !== selfId ? distance(me, user) : null;
                  const userStatus = normalizePresence(user.status);

                  const statusLabel =
                    userStatus === 'away'
                      ? 'Away'
                      : userStatus === 'online'
                        ? 'Online'
                        : d === null
                          ? 'Your position'
                          : d <= DISTANCE_LIMIT
                            ? 'Within earshot range'
                            : `${d}px away`;

                  return (
                    <div className="person" key={user.id}>
                      <div className={`person-avatar ${user.id === selfId ? 'me' : ''}`}>
                        {user.name.slice(0, 1).toUpperCase()}
                      </div>
                      <div className="person-info">
                        <strong>{user.name}{user.id === selfId ? ' (you)' : ''}</strong>
                        <span>{statusLabel}</span>
                      </div>
                      <i
                        className={`person-dot ${userStatus === 'away' ? 'away' : userStatus === 'online' ? 'online' : 'automatic'}`}
                        title={`Status: ${userStatus}`}
                        aria-label={`Status: ${userStatus}`}
                      />
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="panel audio-panel">
              <div className="panel-heading">
                <h2>Audio</h2><span className="audio-icon">♫</span>
              </div>

              <p className="muted small-text">
                Enable your microphone to talk. Move closer to teammates
                to hear them more clearly.
              </p>

              <button
                className={micEnabled ? 'secondary full' : 'primary full'}
                onClick={enableMicrophone}
              >
                {!micReady
                  ? 'Enable microphone'
                  : micEnabled
                    ? 'Mute'
                    : 'Unmute'}
              </button>

              <div className="audio-status">
                <span className={micEnabled ? 'good-dot' : 'neutral-dot'} />
                {!micReady
                  ? 'Microphone is off'
                  : micEnabled
                    ? 'Microphone is on'
                    : 'Microphone is muted'}
              </div>

              <p className="muted small-text">
                WebRTC uses STUN only. Some networks may require TURN for audio.
              </p>
            </section>

            <section className="panel proximity-panel">
              <div className="panel-heading">
                <h2>Nearby teammates</h2><span className="count">{nearby.length}</span>
              </div>

              {nearby.length ? (
                nearby.map((user) => (
                  <div className="nearby-person" key={user.id}>
                    <span className="wave">)))</span>
                    <div>
                      <strong>{user.name}</strong>
                      <p>{distance(me, user)} px away</p>
                    </div>
                  </div>
                ))
              ) : (
                <div className="nearby-empty">
                  <span>◎</span>
                  <p>No one nearby yet</p>
                  <small>Move your avatar closer to a teammate.</small>
                </div>
              )}
            </section>
          </aside>
        </div>

        <footer className="footer">
          <span>ProxiSpeak prototype</span>
          <span>
            {users.length} participant{users.length === 1 ? '' : 's'} · Room: {roomId}
          </span>
        </footer>

        <p className="status bottom-status">{status}</p>
      </div>
    </main>
  );
}
