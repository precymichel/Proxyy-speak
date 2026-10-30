
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
      <main className="ps-entry">
        <section className="ps-entry-story">
          <div className="ps-logo-lockup"><div className="ps-logo">PS</div><div><b>ProxiSpeak</b><small>THE SPACE TO WORK BETTER</small></div></div>
          <div className="ps-entry-copy">
            <span className="ps-overline">YOUR TEAM, IN THE SAME SPACE</span>
            <h1>Good work<br/>happens <em>closer.</em></h1>
            <p>A virtual office that brings spontaneous conversations back to remote work. Walk over, say hello, and collaborate naturally.</p>
            <div className="ps-entry-points"><span><i>01</i> Walk up to teammates</span><span><i>02</i> Talk with spatial audio</span><span><i>03</i> Work together in real time</span></div>
          </div>
          <div className="ps-entry-foot"><span>PROXIMITY-POWERED COLLABORATION</span><span>EST. FOR BETTER TEAMWORK ↗</span></div>
        </section>
        <section className="ps-entry-form-wrap">
          <div className="ps-entry-form-card">
            <span className="ps-overline">GET STARTED</span>
            <h2>Enter your workspace</h2>
            <p>Choose how your teammates will see you and where you want to meet.</p>
            <form onSubmit={joinOffice}>
              <label>DISPLAY NAME<input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Michel" maxLength={24} autoComplete="name" /></label>
              <label>WORKSPACE ID<input value={roomId} onChange={(event) => setRoomId(event.target.value)} placeholder="main-office" maxLength={40} /></label>
              <button className="ps-enter-button" type="submit"><span>Enter workspace</span><span>↗</span></button>
            </form>
            <div className="ps-secure-note"><span className="ps-status-pip"/> Ready when you are <span>·</span> Live presence & spatial audio</div>
            <p className="ps-entry-status" role="status">{status}</p>
          </div>
          <div className="ps-form-caption">NO DOWNLOADS. JUST YOUR TEAM AND A LITTLE MORE ROOM TO CONNECT.</div>
        </section>
      </main>
    );
  }

  const otherParticipants = users.filter((user) => user.id !== selfId);

  // Main virtual office. The collaboration/session logic above remains unchanged.
  return (
    <main className="ps-app">
      <aside className="ps-rail">
        <div className="ps-rail-logo">PS</div>
        <div className="ps-rail-divider" />
        <button className="ps-rail-item active" title="Workspace" aria-label="Workspace"><span>⌂</span></button>
        <button className="ps-rail-item" title="People" aria-label="People"><span>♧</span></button>
        <button className="ps-rail-item" title="Audio" aria-label="Audio"><span>♫</span></button>
        <div className="ps-rail-spacer" />
        <div className="ps-rail-avatar">{(name.trim() || 'M').slice(0,1).toUpperCase()}</div>
      </aside>

      <section className="ps-main-column">
        <header className="ps-topbar">
          <div className="ps-breadcrumb"><span>WORKSPACES</span><b>/</b><strong>{roomId}</strong></div>
          <div className="ps-topbar-actions">
            <span className={`ps-connection ${connected ? 'is-online' : ''}`}><i />{connected ? 'All systems operational' : 'Reconnecting'}</span>
            <label className="ps-presence"><span>STATUS</span><select value={presenceStatus} onChange={(event) => updatePresence(event.target.value)} disabled={!connected} aria-label="Choose your presence status"><option value="auto">Automatic</option><option value="online">Online</option><option value="away">Away</option></select></label>
            <button className="ps-leave" onClick={leaveOffice}>Leave space <span>↗</span></button>
          </div>
        </header>

        <div className="ps-workspace-content">
          <section className="ps-page-heading">
            <div><span className="ps-overline">LIVE COLLABORATION SPACE</span><h1>{roomId}<span className="ps-heading-live"><i/> LIVE</span></h1><p>Your team is one step away. Move around to start a conversation.</p></div>
            <div className="ps-key-guide"><span className="ps-key-icon">⌘</span><div><b>MOVE YOUR AVATAR</b><small><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>or arrow keys</span></small></div></div>
          </section>

          <div className="ps-dashboard-grid">
            <section className="ps-floor-card">
              <div className="ps-section-head"><div><span className="ps-overline">THE FLOOR PLAN</span><h2>Office overview</h2><p>Everyone's position, updated in real time</p></div><div className="ps-floor-meta"><span className="ps-live-indicator"><i/> LIVE MAP</span><span>{users.length} IN SPACE</span></div></div>
              <div className="ps-floor-map">
                <div className="ps-floor-grid" />
                <div className="ps-zone ps-zone-lounge"><span className="ps-zone-label">01 / SOCIAL LOUNGE</span><div className="ps-sofa"><i/><i/><i/></div><div className="ps-plant plant-a">✳</div><div className="ps-plant plant-b">✳</div><span className="ps-zone-caption">Take a break, have a chat</span></div>
                <div className="ps-zone ps-zone-focus"><span className="ps-zone-label">02 / FOCUS PODS</span><div className="ps-focus-desk desk-a"><i/><b/><span/></div><div className="ps-focus-desk desk-b"><i/><b/><span/></div><span className="ps-zone-caption">Quiet space for deep work</span></div>
                <div className="ps-zone ps-zone-meeting"><span className="ps-zone-label">03 / MEETING ROOM</span><div className="ps-meeting-table"><i/><i/><i/><i/><b/></div><span className="ps-zone-caption">Ideas are better together</span></div>
                <div className="ps-zone ps-zone-cafe"><span className="ps-zone-label">04 / THE CAFE</span><div className="ps-cafe-table"><i/><i/><i/><i/></div><span className="ps-zone-caption">Coffee & conversations</span></div>
                <div className="ps-map-crosshair">N <span>↑</span></div>
                {users.map((user) => {
                  const d = me && user.id !== selfId ? distance(me, user) : null;
                  const close = d !== null && d <= DISTANCE_LIMIT;
                  return <div key={user.id} className={`ps-map-person ${user.id === selfId ? 'is-self' : ''} ${close ? 'is-nearby' : ''}`} style={{left:`${(user.x / 800) * 100}%`,top:`${(user.y / 500) * 100}%`}} title={`${user.name}${d !== null ? ` · ${d}px away` : ''}`}><div className="ps-person-marker">{user.name.slice(0,1).toUpperCase()}<span/></div><span className="ps-map-name">{user.name}{user.id === selfId ? ' (you)' : ''}</span></div>;
                })}
                {!users.length && <div className="ps-map-empty"><span>⌁</span><b>Your workspace is ready</b><small>Waiting for teammates to arrive</small></div>}
              </div>
              <div className="ps-map-legend"><span><i className="legend-you"/> YOU</span><span><i className="legend-close"/> IN YOUR RANGE</span><span><i className="legend-away"/> TEAMMATE</span><small>PROXIMITY RANGE · {DISTANCE_LIMIT}px</small></div>
            </section>

            <aside className="ps-right-rail">
              <section className="ps-side-card ps-team-card"><div className="ps-side-title"><div><span className="ps-overline">YOUR CREW</span><h2>People in space</h2></div><span className="ps-count-pill">{users.length.toString().padStart(2,'0')}</span></div><div className="ps-team-summary"><div className="ps-team-avatars">{users.slice(0,4).map((user) => <span key={user.id} title={user.name}>{user.name.slice(0,1).toUpperCase()}</span>)}</div><small>{users.length === 1 ? 'Just you for now' : `${users.length} people sharing this space`}</small></div><div className="ps-member-list">{users.map((user) => {const d = me && user.id !== selfId ? distance(me,user) : null;const userStatus = normalizePresence(user.status);const label = userStatus === 'away' ? 'Away' : user.id === selfId ? 'Your position' : d <= DISTANCE_LIMIT ? 'Nearby · Voice range' : `${d}px away`;return <div className="ps-member" key={user.id}><div className={`ps-member-avatar ${user.id === selfId ? 'self' : ''}`}>{user.name.slice(0,1).toUpperCase()}</div><div className="ps-member-copy"><b>{user.name}{user.id === selfId ? ' (you)' : ''}</b><small>{label}</small></div><i className={`ps-member-status ${userStatus === 'away' ? 'away' : ''}`}/></div>;})}</div></section>

              <section className="ps-side-card ps-nearby-card"><div className="ps-side-title"><div><span className="ps-overline">PROXIMITY</span><h2>Within reach</h2></div><span className="ps-count-pill accent">{nearby.length}</span></div>{nearby.length ? nearby.map((user) => <div className="ps-nearby-row" key={user.id}><span className="ps-signal-icon">)))</span><div><b>{user.name}</b><small>{distance(me,user)}px · Voice can connect</small></div><span className="ps-nearby-dot"/></div>) : <div className="ps-nearby-empty"><span>⌖</span><b>No one in range</b><small>Move closer to a teammate to start a conversation.</small></div>}</section>

              <section className="ps-tip-card"><span className="ps-tip-icon">✦</span><div><b>Make it spontaneous</b><p>Walk your avatar over to a teammate. Your voices get clearer as you get closer.</p></div></section>
            </aside>
          </div>

          <footer className="ps-footer"><span>PROXISPEAK <b>·</b> SPATIAL WORKSPACE</span><span>{otherParticipants.length} TEAMMATE{otherParticipants.length === 1 ? '' : 'S'} <b>·</b> ROOM {roomId.toUpperCase()}</span></footer>
        </div>

        <div className="ps-audio-dock"><div className="ps-audio-identity"><span className={`ps-audio-avatar ${micEnabled ? 'speaking' : ''}`}>{(name.trim() || 'M').slice(0,1).toUpperCase()}</span><div><b>Your audio</b><small>{micEnabled ? 'Microphone is live' : micReady ? 'Microphone muted' : 'Microphone is off'}</small></div></div><div className="ps-audio-center"><span className={`ps-audio-state ${micEnabled ? 'active' : ''}`}><i/>{micEnabled ? 'VOICE ACTIVE' : 'VOICE STANDBY'}</span><div className={`ps-audio-wave ${micEnabled ? 'moving' : ''}`}><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/></div><small>Spatial audio · {nearby.length} nearby</small></div><button className={`ps-mic-button ${micEnabled ? 'muted' : ''}`} onClick={enableMicrophone}><span>{micEnabled ? 'Ⅱ' : '♩'}</span>{!micReady ? 'Enable microphone' : micEnabled ? 'Mute microphone' : 'Unmute microphone'}</button><div className="ps-audio-help">{status}</div></div>
      </section>
    </main>
  );
}
