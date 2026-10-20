import React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SERVER_URL =
  import.meta.env.VITE_SERVER_URL || 'http://localhost:4000';

const DISTANCE_LIMIT = 180;

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

  // Presence status: auto, online, or away.
  const [presenceStatus, setPresenceStatus] = useState('auto');

  const [status, setStatus] = useState(
    'Join the office to get started.'
  );

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

  // Send a manual or automatic presence preference to the backend.
  const updatePresence = useCallback((nextStatus) => {
    const validStatus = normalizePresence(nextStatus);

    setPresenceStatus(validStatus);
    presenceRef.current = validStatus;

    const socket = socketRef.current;

    if (socket?.connected) {
      socket.emit('presence:update', {
        status: validStatus
      });
    }
  }, []);

  const sendSignal = useCallback((targetId, signal) => {
    socketRef.current?.emit('audio:signal', {
      targetId,
      signal
    });
  }, []);

  const getPeer = useCallback(
    (peerId) => {
      let pc = peersRef.current.get(peerId);

      if (pc) return pc;

      pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' }
        ]
      });

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendSignal(peerId, {
            type: 'ice',
            candidate: event.candidate
          });
        }
      };

      pc.ontrack = (event) => {
        let audio = audioElsRef.current.get(peerId);

        if (!audio) {
          audio = document.createElement('audio');
          audio.autoplay = true;
          audio.playsInline = true;
          audio.dataset.peerId = peerId;

          document.body.appendChild(audio);
          audioElsRef.current.set(peerId, audio);
        }

        audio.srcObject = event.streams[0];
        audio.volume = 0.8;

        audio.play().catch(() => {
          setStatus(
            'Remote audio is ready. Click the page if your browser blocks autoplay.'
          );
        });
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') {
          setStatus(
            'Audio connection failed. Network may require a TURN server.'
          );
        }
      };

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => {
          pc.addTrack(track, streamRef.current);
        });
      }

      peersRef.current.set(peerId, pc);
      return pc;
    },
    [sendSignal]
  );

  const startPeerCall = useCallback(
    async (peerId) => {
      if (!streamRef.current || !selfIdRef.current) return;

      // Only one side creates the offer.
      if (selfIdRef.current.localeCompare(peerId) > 0) return;

      const pc = getPeer(peerId);

      if (pc.signalingState !== 'stable') return;

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        sendSignal(peerId, {
          type: 'description',
          description: pc.localDescription
        });
      } catch (error) {
        setStatus(
          `Could not start audio with teammate: ${error.message}`
        );
      }
    },
    [getPeer, sendSignal]
  );

  const closePeer = useCallback((peerId) => {
    const pc = peersRef.current.get(peerId);

    if (pc) pc.close();

    peersRef.current.delete(peerId);

    const audio = audioElsRef.current.get(peerId);

    if (audio) {
      audio.srcObject = null;
      audio.remove();
    }

    audioElsRef.current.delete(peerId);
  }, []);

  const me = users.find((user) => user.id === selfId);

  const nearby = useMemo(
    () =>
      me
        ? users.filter(
            (user) =>
              user.id !== selfId &&
              distance(me, user) <= DISTANCE_LIMIT
          )
        : [],
    [users, selfId, me]
  );

  const joinOffice = (event) => {
    event.preventDefault();

    // Avoid multiple active connections after repeated form submissions.
    socketRef.current?.disconnect();

    const requestedName = name.trim() || 'Guest';
    const requestedRoom = roomId.trim() || 'main-office';

    const socket = io(SERVER_URL);
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      setStatus('Connected. Joining your office...');

      socket.emit('office:join', {
        name: requestedName,
        roomId: requestedRoom
      });
    });

    socket.on('connect_error', () => {
      setConnected(false);
      setStatus(
        'Cannot reach the server. Start the server and try again.'
      );
    });

    socket.on('disconnect', () => {
      setConnected(false);
      setStatus('Connection lost. Trying to reconnect...');
    });

    socket.on('office:join:error', ({ message } = {}) => {
      setStatus(message || 'Could not join the office. Please try again.');
    });

    socket.on('office:joined', ({ selfId: id, users: initialUsers } = {}) => {
      const roster = Array.isArray(initialUsers) ? initialUsers : [];

      setSelfId(id || '');
      setUsers(roster);

      selfRef.current =
        roster.find((user) => user.id === id) || null;

      setJoined(true);

      // Restore the selected preference after joining or reconnecting.
      socket.emit('presence:update', {
        status: presenceRef.current
      });

      setStatus(
        `Joined ${requestedRoom}. ${roster.length} participant(s) currently in this room.`
      );
    });

    socket.on('user:joined', (user) => {
      if (!user?.id) return;

      setUsers((current) => {
        const exists = current.some((item) => item.id === user.id);

        return exists
          ? current.map((item) =>
              item.id === user.id ? { ...item, ...user } : item
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
              item.id === user.id ? { ...item, ...user } : item
            )
          : [...current, user];
      });

      if (user.id === socket.id) {
        selfRef.current = user;
      }
    });

    socket.on('users:update', (nextUsers) => {
      const roster = Array.isArray(nextUsers) ? nextUsers : [];

      setUsers(roster);
      selfRef.current =
        roster.find((user) => user.id === socket.id) || null;
    });

    socket.on('user:left', ({ id } = {}) => {
      if (!id) return;

      setUsers((current) =>
        current.filter((user) => user.id !== id)
      );

      closePeer(id);
      setStatus('A participant left the office.');
    });

    socket.on('audio:signal', async ({ fromId, signal } = {}) => {
      if (fromId && signal) {
        await handleSignal(fromId, signal);
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
      y: Math.max(24, Math.min(476, current.y + dy))
    };

    selfRef.current = next;

    setUsers((old) =>
      old.map((user) => (user.id === next.id ? next : user))
    );

    socket.emit('avatar:move', {
      x: next.x,
      y: next.y
    });
  }, []);

  // Keyboard movement.
  useEffect(() => {
    if (!joined) return;

    const down = (event) => {
      if (
        [
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'w',
          'a',
          's',
          'd',
          'W',
          'A',
          'S',
          'D'
        ].includes(event.key)
      ) {
        event.preventDefault();
      }

      keysRef.current[event.key.toLowerCase()] = true;
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

        if (dx || dy) {
          move(dx * 8, dy * 8);
        }

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

  // Spatial audio attenuation based on participant distance.
  useEffect(() => {
    if (!me) return;

    users
      .filter((user) => user.id !== selfId)
      .forEach((user) => {
        const audio = audioElsRef.current.get(user.id);

        if (!audio) return;

        const d = distance(me, user);
        audio.volume = Math.max(0, Math.min(1, 1 - d / 300));
      });
  }, [users, selfId, me]);

  // Close active connections and audio elements when leaving the page.
  useEffect(
    () => () => {
      socketRef.current?.disconnect();

      streamRef.current?.getTracks().forEach((track) => track.stop());

      peersRef.current.forEach((pc) => pc.close());

      audioElsRef.current.forEach((audio) => {
        audio.srcObject = null;
        audio.remove();
      });

      audioElsRef.current.clear();
    },
    []
  );

  useEffect(() => {
    if (!joined || !micEnabled || !selfId) return;

    users
      .filter(
        (user) =>
          user.id !== selfId &&
          user.roomId === roomId &&
          distance(me || user, user) <= DISTANCE_LIMIT
      )
      .forEach((user) => {
        startPeerCall(user.id);
      });
  }, [joined, micEnabled, selfId, users, roomId, me, startPeerCall]);

  async function handleSignal(fromId, signal) {
    try {
      const pc = getPeer(fromId);

      if (signal?.type === 'description' && signal.description) {
        await pc.setRemoteDescription(
          new RTCSessionDescription(signal.description)
        );

        if (signal.description.type === 'offer') {
          if (streamRef.current) {
            const answer = await pc.createAnswer();

            await pc.setLocalDescription(answer);

            sendSignal(fromId, {
              type: 'description',
              description: pc.localDescription
            });
          }
        }
      } else if (signal?.type === 'ice' && signal.candidate) {
        await pc.addIceCandidate(
          new RTCIceCandidate(signal.candidate)
        );
      }
    } catch (error) {
      setStatus(`Audio signaling issue: ${error.message}`);
    }
  }

  async function enableMicrophone() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true
      });

      streamRef.current = stream;

      peersRef.current.forEach((pc) => {
        stream.getTracks().forEach((track) => {
          const alreadyAdded = pc
            .getSenders()
            .some((sender) => sender.track?.id === track.id);

          if (!alreadyAdded) {
            pc.addTrack(track, stream);
          }
        });
      });

      setMicEnabled(true);

      setStatus(
        'Microphone enabled. Nearby peers can establish audio; use HTTPS or localhost.'
      );
    } catch (error) {
      setStatus(
        `Microphone unavailable: ${error.message}. Use localhost or HTTPS and allow microphone access.`
      );
    }
  }

  // Login screen.
  if (!joined) {
    return (
      <main className="join-screen join-split-screen">
        <section
          className="join-welcome-panel"
          aria-label="Welcome to ProxiSpeak"
        >
          <div className="join-brand-lockup">
            <div className="brand-mark">PS</div>

            <div>
              <div className="join-brand-name">
                Proxi<span>Speak</span>
              </div>
              <p>Virtual Office. Real Conversations.</p>
            </div>
          </div>

          <div className="join-welcome-copy">
            <p className="join-kicker">YOUR TEAM, CLOSER</p>

            <h1>
              Work Together.
              <br />
              Feel <span>Closer.</span>
            </h1>

            <p className="join-description">
              Move around, talk naturally, and collaborate in a virtual
              space — just like a real office.
            </p>

            <ul className="join-feature-list">
              <li>
                <span className="join-feature-icon">◉</span>
                <span>Real-time spatial audio</span>
              </li>
              <li>
                <span className="join-feature-icon">▦</span>
                <span>Interactive office spaces</span>
              </li>
              <li>
                <span className="join-feature-icon">↗</span>
                <span>More natural collaboration</span>
              </li>
            </ul>
          </div>

          <p className="join-welcome-footer">
            A shared space for better teamwork.
          </p>
        </section>

        <section
          className="join-form-panel"
          aria-label="Join your virtual office"
        >
          <div className="join-card">
            <div className="join-form-brand">
              <div className="brand-mark">PS</div>

              <div>
                <div className="join-brand-name">
                  Proxi<span>Speak</span>
                </div>
                <p>Virtual Office. Real Conversations.</p>
              </div>
            </div>

            <p className="eyebrow">JOIN YOUR SPACE</p>

            <h2>
              Welcome to Proxi<span>Speak</span>
            </h2>

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
                <span>Join Office</span>
                <span aria-hidden="true">→</span>
              </button>
            </form>

            <div className="join-ready-status">
              <span className="join-ready-dot" />

              <div>
                <strong>Ready to connect</strong>
                <p>Real-time audio · Move freely · Work together</p>
              </div>
            </div>

            <p className="status join-form-status" role="status">
              {status}
            </p>
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
            <i />
            {connected ? 'Connected' : 'Connecting'}
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

          <button
            className="secondary"
            onClick={() => {
              socketRef.current?.disconnect();
              window.location.reload();
            }}
          >
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

              <span className="live-pill">
                <i /> LIVE
              </span>
            </div>

            <div className="office-map">
              <div className="room room-one">
                <span>COLLAB ZONE</span>
                <div className="couch" />
                <div className="plant">♣</div>
              </div>

              <div className="room room-two">
                <span>FOCUS AREA</span>
                <div className="desk">
                  <i />
                  <i />
                </div>
                <div className="desk second">
                  <i />
                  <i />
                </div>
              </div>

              <div className="room room-three">
                <span>MEETING ROOM</span>
                <div className="meeting-table" />
              </div>

              <div className="room room-four">
                <span>LOUNGE</span>
                <div className="round-table" />
              </div>

              {users.map((user) => {
                const d =
                  me && user.id !== selfId
                    ? distance(me, user)
                    : null;

                const close = d !== null && d <= DISTANCE_LIMIT;

                return (
                  <div
                    key={user.id}
                    className={`avatar ${
                      user.id === selfId ? 'self' : ''
                    } ${close ? 'nearby' : ''}`}
                    style={{
                      left: `${(user.x / 800) * 100}%`,
                      top: `${(user.y / 500) * 100}%`
                    }}
                    title={`${user.name}${
                      d !== null ? ` · ${d}px away` : ''
                    }`}
                  >
                    <div className="avatar-face">
                      {user.name.slice(0, 1).toUpperCase()}
                    </div>

                    <span>
                      {user.name}
                      {user.id === selfId ? ' (you)' : ''}
                    </span>
                  </div>
                );
              })}

              {!users.length && (
                <div className="empty-map">
                  Waiting for teammates to join…
                </div>
              )}
            </div>

            <div className="map-footer">
              <span>
                <i className="legend-self" /> You
              </span>
              <span>
                <i className="legend-near" /> Nearby teammate
              </span>
              <span>
                <i className="legend-other" /> Other teammate
              </span>
            </div>
          </section>

          <aside className="side-column">
            <section className="panel">
              <div className="panel-heading">
                <h2>People here</h2>
                <span className="count">{users.length}</span>
              </div>

              <div className="people-list">
                {users.map((user) => {
                  const d =
                    me && user.id !== selfId
                      ? distance(me, user)
                      : null;

                  const userStatus = normalizePresence(
                    user.status
                  );

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
                      <div
                        className={`person-avatar ${
                          user.id === selfId ? 'me' : ''
                        }`}
                      >
                        {user.name.slice(0, 1).toUpperCase()}
                      </div>

                      <div className="person-info">
                        <strong>
                          {user.name}
                          {user.id === selfId ? ' (you)' : ''}
                        </strong>
                        <span>{statusLabel}</span>
                      </div>

                      <i
                        className={`person-dot ${
                          userStatus === 'away'
                            ? 'away'
                            : userStatus === 'online'
                              ? 'online'
                              : 'automatic'
                        }`}
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
                <h2>Audio</h2>
                <span className="audio-icon">♫</span>
              </div>

              <p className="muted small-text">
                Allow microphone access to prepare for voice chat.
                Spatial audio integration needs final peer-connection
                testing.
              </p>

              <button
                className={micEnabled ? 'secondary full' : 'primary full'}
                onClick={enableMicrophone}
              >
                {micEnabled
                  ? '✓ Microphone enabled'
                  : 'Enable microphone'}
              </button>

              <div className="audio-status">
                <span
                  className={
                    micEnabled ? 'good-dot' : 'neutral-dot'
                  }
                />
                {micEnabled
                  ? 'Microphone permission granted'
                  : 'Microphone is off'}
              </div>
            </section>

            <section className="panel proximity-panel">
              <div className="panel-heading">
                <h2>Nearby teammates</h2>
                <span className="count">{nearby.length}</span>
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
                  <small>
                    Move your avatar closer to a teammate.
                  </small>
                </div>
              )}
            </section>
          </aside>
        </div>

        <footer className="footer">
          <span>ProxiSpeak prototype</span>
          <span>
            {users.length} participant
            {users.length === 1 ? '' : 's'} · Room: {roomId}
          </span>
        </footer>

        <p className="status bottom-status">{status}</p>
      </div>
    </main>
  );
}