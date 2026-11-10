import { calculateAttenuation, calculateStereoPan } from './attenuation.js';

const DEFAULT_RANGE = 100;

/**
 * Routes remote HTMLAudioElements through Web Audio:
 * MediaElementSource -> GainNode -> StereoPannerNode -> destination.
 *
 * The HTMLAudioElement remains responsible for autoplay/stream lifecycle.
 * Web Audio controls only volume and stereo position.
 */
export class AudioEngine {
  constructor({ maxDistance = DEFAULT_RANGE } = {}) {
    this.maxDistance = maxDistance;
    this.context = null;
    this.connections = new Map();
  }

  getContext() {
    if (this.context) return this.context;

    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) {
      console.warn('Web Audio API is not supported in this browser.');
      return null;
    }

    this.context = new Context();
    return this.context;
  }

  async resume() {
    const context = this.getContext();
    if (context && context.state === 'suspended') {
      try {
        await context.resume();
      } catch (error) {
        console.warn('Could not resume audio context:', error);
      }
    }
  }

  attachElement(peerId, audioElement) {
    if (!peerId || !audioElement || this.connections.has(peerId)) return;

    const context = this.getContext();
    if (!context) return;

    try {
      const source = context.createMediaElementSource(audioElement);
      const gain = context.createGain();
      const panner = context.createStereoPanner
        ? context.createStereoPanner()
        : null;

      gain.gain.value = 1;
      if (panner) {
        source.connect(gain);
        gain.connect(panner);
        panner.connect(context.destination);
      } else {
        source.connect(gain);
        gain.connect(context.destination);
      }

      this.connections.set(peerId, { source, gain, panner });
      this.resume();
    } catch (error) {
      // A media element can only be wrapped by one MediaElementSourceNode.
      console.warn(`Could not attach spatial audio for ${peerId}:`, error);
    }
  }

  updatePeer(peerId, { distance, deltaX = 0, maxDistance = this.maxDistance } = {}) {
    const nodes = this.connections.get(peerId);
    if (!nodes || !this.context) return;

    const gainValue = calculateAttenuation(distance, maxDistance);
    const panValue = calculateStereoPan(deltaX, maxDistance);
    const now = this.context.currentTime;

    // Smoothly ramp values to prevent clicks/pops during avatar movement.
    nodes.gain.gain.cancelScheduledValues(now);
    nodes.gain.gain.setTargetAtTime(gainValue, now, 0.08);

    if (nodes.panner) {
      nodes.panner.pan.cancelScheduledValues(now);
      nodes.panner.pan.setTargetAtTime(panValue, now, 0.08);
    }
  }

  /**
   * Applies microphone mute to the captured stream and active WebRTC senders.
   * MediaStreamTrack.enabled=false sends silence; applying it to each sender's
   * current track also covers connections created before/after a UI toggle.
   */
  setMicrophoneMuted(stream, muted, peerConnections = new Map()) {
    if (!stream) {
      console.warn('Cannot change microphone mute: stream not found.');
      return false;
    }

    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      console.warn('Cannot change microphone mute: no audio tracks found.');
      return false;
    }

    audioTracks.forEach((track) => {
      track.enabled = !muted;
    });

    for (const pc of peerConnections.values()) {
      if (!pc || typeof pc.getSenders !== 'function') continue;

      pc.getSenders().forEach((sender) => {
        if (sender.track?.kind === 'audio') {
          sender.track.enabled = !muted;
        }
      });
    }

    return audioTracks.every((track) => track.enabled === !muted);
  }

  removePeer(peerId) {
    const nodes = this.connections.get(peerId);
    if (!nodes) return;

    try { nodes.source.disconnect(); } catch {}
    try { nodes.gain.disconnect(); } catch {}
    try { nodes.panner?.disconnect(); } catch {}
    this.connections.delete(peerId);
  }

  close() {
    for (const peerId of this.connections.keys()) {
      this.removePeer(peerId);
    }
    if (this.context && this.context.state !== 'closed') {
      this.context.close().catch(() => {});
    }
    this.context = null;
  }
}
