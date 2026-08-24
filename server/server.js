/**
 * WebRTC Room — mediasoup SFU server
 * ICE-Lite: server advertises fixed host candidates (listenInfos + announcedAddress)
 * Optional ICE_SERVERS (STUN/TURN) are forwarded to browsers on join
 */
'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const mediasoup = require('mediasoup');
const { loadIceServers } = require('./ice-servers');

const PORT = Number(process.env.PORT) || 3000;
const LISTEN_IP = process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0';
const RTC_MIN_PORT = Number(process.env.MEDIASOUP_MIN_PORT) || 40000;
const RTC_MAX_PORT = Number(process.env.MEDIASOUP_MAX_PORT) || 49999;
const MAX_PEERS_PER_ROOM = Number(process.env.MAX_PEERS) || 12;
const ICE_SERVERS = loadIceServers();

function resolveAnnouncedAddress() {
  const env =
    process.env.ANNOUNCED_IP ||
    process.env.MEDIASOUP_ANNOUNCED_IP ||
    process.env.MEDIASOUP_ANNOUNCED_ADDRESS ||
    '';
  if (env.trim()) return env.trim();

  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets || {})) {
    for (const net of nets[name] || []) {
      const family = net.family === 'IPv4' || net.family === 4;
      if (family && !net.internal) return net.address;
    }
  }
  return null;
}

const ANNOUNCED_ADDRESS = resolveAnnouncedAddress();

function buildListenInfos() {
  const announcedAddress = ANNOUNCED_ADDRESS || undefined;
  if (LISTEN_IP === '0.0.0.0' || LISTEN_IP === '::') {
    if (!announcedAddress) {
      console.warn(
        '[ice] WARNING: listening on ' +
          LISTEN_IP +
          ' without ANNOUNCED_IP — ICE candidates may be unusable for remote clients. ' +
          'Set ANNOUNCED_IP to your public IP or hostname.'
      );
    }
  }
  return [
    { protocol: 'udp', ip: LISTEN_IP, announcedAddress },
    { protocol: 'tcp', ip: LISTEN_IP, announcedAddress },
  ];
}

const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 },
  },
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    parameters: { 'profile-id': 2, 'x-google-start-bitrate': 1000 },
  },
  {
    kind: 'video',
    mimeType: 'video/h264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 1000,
    },
  },
];

function webRtcTransportOptions() {
  return {
    listenInfos: buildListenInfos(),
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1_000_000,
    maxIncomingBitrate: 3_000_000,
  };
}

let workers = [];
let nextWorkerIdx = 0;
const rooms = new Map();

function getNextWorker() {
  const worker = workers[nextWorkerIdx];
  nextWorkerIdx = (nextWorkerIdx + 1) % workers.length;
  return worker;
}

class Peer {
  constructor(id, displayName, ws) {
    this.id = id;
    this.displayName = displayName || 'Guest';
    this.ws = ws;
    this.transports = new Map();
    this.producers = new Map();
    this.consumers = new Map();
    this.joinedAt = Date.now();
  }

  send(msg) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  close() {
    for (const c of this.consumers.values()) {
      try {
        c.close();
      } catch (_) {}
    }
    for (const p of this.producers.values()) {
      try {
        p.close();
      } catch (_) {}
    }
    for (const t of this.transports.values()) {
      try {
        t.close();
      } catch (_) {}
    }
    this.consumers.clear();
    this.producers.clear();
    this.transports.clear();
  }
}

class Room {
  constructor(id, router) {
    this.id = id;
    this.router = router;
    this.peers = new Map();
    this.pin = null;
  }

  get peerCount() {
    return this.peers.size;
  }

  broadcast(msg, exceptId = null) {
    for (const [id, peer] of this.peers) {
      if (id !== exceptId) peer.send(msg);
    }
  }

  peerList() {
    return [...this.peers.values()].map((p) => ({
      id: p.id,
      displayName: p.displayName,
      producers: [...p.producers.values()].map((pr) => ({
        id: pr.id,
        kind: pr.kind,
        appData: pr.appData || {},
      })),
    }));
  }

  async closeIfEmpty() {
    if (this.peers.size === 0) {
      try {
        this.router.close();
      } catch (_) {}
      rooms.delete(this.id);
      console.log(`[room] closed empty room ${this.id}`);
    }
  }
}

async function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (room) return room;

  const worker = getNextWorker();
  const router = await worker.createRouter({ mediaCodecs });
  room = new Room(roomId, router);
  rooms.set(roomId, room);
  console.log(`[room] created ${roomId}`);
  return room;
}

async function createWorkers() {
  const num = Math.max(1, Math.min(4, os.cpus().length));
  for (let i = 0; i < num; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: process.env.MEDIASOUP_LOG_LEVEL || 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
      rtcMinPort: RTC_MIN_PORT,
      rtcMaxPort: RTC_MAX_PORT,
    });
    worker.on('died', () => {
      console.error('[mediasoup] worker died, exiting in 2s');
      setTimeout(() => process.exit(1), 2000);
    });
    workers.push(worker);
    console.log(`[mediasoup] worker #${i} pid=${worker.pid}`);
  }
}

function genId(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function safeRoomId(raw) {
  if (!raw || typeof raw !== 'string') return genId('r');
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  return cleaned || genId('r');
}

function normalizePin(raw) {
  if (raw == null || raw === '') return null;
  return String(raw).slice(0, 32);
}

function formatIceCandidates(cands) {
  return (cands || []).map((c) => ({
    foundation: c.foundation,
    priority: c.priority,
    ip: c.ip,
    protocol: c.protocol,
    port: c.port,
    type: c.type,
  }));
}

function attachWs(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const peerId = genId('p');
    let peer = null;
    let room = null;

    console.log(`[ws] connect ${peerId} from ${req.socket.remoteAddress}`);

    const send = (msg) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    };

    ws.on('message', async (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return send({ type: 'error', error: 'invalid_json' });
      }

      const { type, requestId } = data;
      const reply = (payload) => send({ ...payload, requestId });

      try {
        switch (type) {
          case 'join': {
            if (peer) return reply({ type: 'error', error: 'already_joined' });
            const roomId = safeRoomId(data.roomId);
            const displayName = String(data.displayName || 'Guest').slice(0, 32);
            const pin = normalizePin(data.pin);

            room = await getOrCreateRoom(roomId);

            if (room.peerCount === 0) {
              room.pin = pin;
            } else if (room.pin) {
              if (pin !== room.pin) {
                return reply({ type: 'error', error: 'invalid_pin' });
              }
            }

            if (room.peerCount >= MAX_PEERS_PER_ROOM) {
              return reply({ type: 'error', error: 'room_full' });
            }

            peer = new Peer(peerId, displayName, ws);
            room.peers.set(peerId, peer);

            const existingProducers = [];
            for (const [otherId, other] of room.peers) {
              if (otherId === peerId) continue;
              for (const prod of other.producers.values()) {
                existingProducers.push({
                  peerId: otherId,
                  producerId: prod.id,
                  kind: prod.kind,
                  appData: prod.appData || {},
                  displayName: other.displayName,
                });
              }
            }

            reply({
              type: 'joined',
              peerId,
              roomId: room.id,
              displayName,
              hasPin: Boolean(room.pin),
              rtpCapabilities: room.router.rtpCapabilities,
              peers: room.peerList().filter((p) => p.id !== peerId),
              existingProducers,
              ice: {
                announcedAddress: ANNOUNCED_ADDRESS,
                listenIp: LISTEN_IP,
                mode: 'ice-lite',
              },
              iceServers: ICE_SERVERS,
            });

            room.broadcast(
              { type: 'peerJoined', peer: { id: peerId, displayName, producers: [] } },
              peerId
            );
            console.log(`[room ${room.id}] ${displayName} (${peerId}) joined — ${room.peerCount} peers`);
            break;
          }

          case 'createWebRtcTransport': {
            if (!peer || !room) return reply({ type: 'error', error: 'not_joined' });

            const transport = await room.router.createWebRtcTransport({
              ...webRtcTransportOptions(),
              appData: { peerId, direction: data.direction || 'sendrecv' },
            });

            transport.on('dtlsstatechange', (state) => {
              if (state === 'closed') transport.close();
            });
            transport.on('icestatechange', (state) => {
              console.log(`[ice] transport ${transport.id} iceState=${state}`);
            });
            transport.on('close', () => peer?.transports.delete(transport.id));

            peer.transports.set(transport.id, transport);

            const iceCandidates = transport.iceCandidates;
            console.log(
              `[ice] transport ${transport.id} candidates:`,
              JSON.stringify(formatIceCandidates(iceCandidates))
            );

            reply({
              type: 'webRtcTransportCreated',
              id: transport.id,
              iceParameters: transport.iceParameters,
              iceCandidates,
              dtlsParameters: transport.dtlsParameters,
              iceServers: ICE_SERVERS,
            });
            break;
          }

          case 'connectWebRtcTransport': {
            if (!peer) return reply({ type: 'error', error: 'not_joined' });
            const transport = peer.transports.get(data.transportId);
            if (!transport) return reply({ type: 'error', error: 'transport_not_found' });
            await transport.connect({ dtlsParameters: data.dtlsParameters });
            reply({ type: 'webRtcTransportConnected', id: transport.id });
            break;
          }

          case 'produce': {
            if (!peer || !room) return reply({ type: 'error', error: 'not_joined' });
            const transport = peer.transports.get(data.transportId);
            if (!transport) return reply({ type: 'error', error: 'transport_not_found' });
            const producer = await transport.produce({
              kind: data.kind,
              rtpParameters: data.rtpParameters,
              appData: data.appData || {},
            });
            peer.producers.set(producer.id, producer);
            producer.on('transportclose', () => peer?.producers.delete(producer.id));
            reply({ type: 'produced', id: producer.id });
            room.broadcast(
              {
                type: 'newProducer',
                peerId: peer.id,
                displayName: peer.displayName,
                producerId: producer.id,
                kind: producer.kind,
                appData: producer.appData || {},
              },
              peer.id
            );
            break;
          }

          case 'consume': {
            if (!peer || !room) return reply({ type: 'error', error: 'not_joined' });
            let targetProducer = null;
            let producerPeerId = null;
            for (const [oid, other] of room.peers) {
              const p = other.producers.get(data.producerId);
              if (p) {
                targetProducer = p;
                producerPeerId = oid;
                break;
              }
            }
            if (!targetProducer) return reply({ type: 'error', error: 'producer_not_found' });
            if (
              !room.router.canConsume({
                producerId: targetProducer.id,
                rtpCapabilities: data.rtpCapabilities,
              })
            ) {
              return reply({ type: 'error', error: 'cannot_consume' });
            }
            const transport = peer.transports.get(data.transportId);
            if (!transport) return reply({ type: 'error', error: 'transport_not_found' });
            const consumer = await transport.consume({
              producerId: targetProducer.id,
              rtpCapabilities: data.rtpCapabilities,
              paused: true,
            });
            peer.consumers.set(consumer.id, consumer);
            consumer.on('transportclose', () => peer?.consumers.delete(consumer.id));
            consumer.on('producerclose', () => {
              peer?.consumers.delete(consumer.id);
              peer?.send({
                type: 'consumerClosed',
                consumerId: consumer.id,
                producerId: targetProducer.id,
              });
            });
            reply({
              type: 'consumed',
              id: consumer.id,
              producerId: targetProducer.id,
              peerId: producerPeerId,
              kind: consumer.kind,
              rtpParameters: consumer.rtpParameters,
              appData: targetProducer.appData || {},
              producerPaused: targetProducer.paused,
            });
            break;
          }

          case 'resumeConsumer': {
            if (!peer) return reply({ type: 'error', error: 'not_joined' });
            const consumer = peer.consumers.get(data.consumerId);
            if (!consumer) return reply({ type: 'error', error: 'consumer_not_found' });
            await consumer.resume();
            reply({ type: 'consumerResumed', id: consumer.id });
            break;
          }

          case 'pauseProducer': {
            if (!peer) return reply({ type: 'error', error: 'not_joined' });
            const producer = peer.producers.get(data.producerId);
            if (!producer) return reply({ type: 'error', error: 'producer_not_found' });
            await producer.pause();
            room?.broadcast(
              { type: 'producerPaused', peerId: peer.id, producerId: producer.id },
              peer.id
            );
            reply({ type: 'ok' });
            break;
          }

          case 'resumeProducer': {
            if (!peer) return reply({ type: 'error', error: 'not_joined' });
            const producer = peer.producers.get(data.producerId);
            if (!producer) return reply({ type: 'error', error: 'producer_not_found' });
            await producer.resume();
            room?.broadcast(
              { type: 'producerResumed', peerId: peer.id, producerId: producer.id },
              peer.id
            );
            reply({ type: 'ok' });
            break;
          }

          case 'closeProducer': {
            if (!peer || !room) return reply({ type: 'error', error: 'not_joined' });
            const producer = peer.producers.get(data.producerId);
            if (producer) {
              producer.close();
              peer.producers.delete(producer.id);
              room.broadcast(
                { type: 'producerClosed', peerId: peer.id, producerId: producer.id },
                peer.id
              );
            }
            reply({ type: 'ok' });
            break;
          }

          case 'chat': {
            if (!peer || !room) return reply({ type: 'error', error: 'not_joined' });
            const text = String(data.text || '').slice(0, 500).trim();
            if (!text) return reply({ type: 'error', error: 'empty' });
            room.broadcast({
              type: 'chat',
              peerId: peer.id,
              displayName: peer.displayName,
              text,
              ts: Date.now(),
            });
            reply({ type: 'ok' });
            break;
          }

          case 'reaction': {
            if (!peer || !room) return reply({ type: 'error', error: 'not_joined' });
            const emoji = String(data.emoji || '').slice(0, 8);
            if (!emoji) return;
            room.broadcast({
              type: 'reaction',
              peerId: peer.id,
              displayName: peer.displayName,
              emoji,
              ts: Date.now(),
            });
            reply({ type: 'ok' });
            break;
          }

          case 'updateDisplayName': {
            if (!peer || !room) return reply({ type: 'error', error: 'not_joined' });
            peer.displayName = String(data.displayName || 'Guest').slice(0, 32);
            room.broadcast({
              type: 'peerUpdated',
              peerId: peer.id,
              displayName: peer.displayName,
            });
            reply({ type: 'ok', displayName: peer.displayName });
            break;
          }

          case 'leave': {
            cleanup();
            reply({ type: 'left' });
            break;
          }

          case 'ping': {
            reply({ type: 'pong', t: Date.now() });
            break;
          }

          default:
            reply({ type: 'error', error: 'unknown_type', received: type });
        }
      } catch (err) {
        console.error(`[ws] error handling ${type}:`, err);
        reply({ type: 'error', error: err.message || 'internal' });
      }
    });

    function cleanup() {
      if (!peer || !room) return;
      const rid = room.id;
      const name = peer.displayName;
      const pid = peer.id;
      for (const prod of peer.producers.values()) {
        room.broadcast({ type: 'producerClosed', peerId: pid, producerId: prod.id }, pid);
      }
      peer.close();
      room.peers.delete(pid);
      room.broadcast({ type: 'peerLeft', peerId: pid, displayName: name });
      console.log(`[room ${rid}] ${name} left — ${room.peerCount} peers`);
      room.closeIfEmpty();
      peer = null;
      room = null;
    }

    ws.on('close', () => {
      cleanup();
      console.log(`[ws] closed ${peerId}`);
    });

    ws.on('error', (err) => {
      console.error(`[ws] error ${peerId}:`, err.message);
    });
  });

  return wss;
}

async function main() {
  await createWorkers();

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      rooms: rooms.size,
      peers: [...rooms.values()].reduce((n, r) => n + r.peerCount, 0),
      workers: workers.length,
      ice: {
        mode: 'ice-lite',
        listenIp: LISTEN_IP,
        announcedAddress: ANNOUNCED_ADDRESS,
        rtcPorts: `${RTC_MIN_PORT}-${RTC_MAX_PORT}`,
        iceServersConfigured: ICE_SERVERS.length,
      },
      uptime: Math.round(process.uptime()),
    });
  });

  const clientDir = path.join(__dirname, '..', 'client');
  app.use(express.static(clientDir, { index: 'index.html', maxAge: '1h', etag: true }));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });

  const server = http.createServer(app);
  attachWs(server);

  server.listen(PORT, () => {
    console.log(`\n  WebRTC Room SFU  http://0.0.0.0:${PORT}`);
    console.log(`  WebSocket         /ws`);
    console.log(`  Health            /health`);
    console.log(`  ICE mode          ice-lite`);
    console.log(`  Listen IP         ${LISTEN_IP}`);
    console.log(
      `  Announced         ${ANNOUNCED_ADDRESS || '(none — set ANNOUNCED_IP for cloud/NAT)'}`
    );
    console.log(`  ICE servers       ${ICE_SERVERS.length} (STUN/TURN for browsers)`);
    console.log(`  RTC ports         ${RTC_MIN_PORT}-${RTC_MAX_PORT}\n`);
  });

  const shutdown = () => {
    console.log('\nShutting down…');
    server.close(() => {
      for (const w of workers) {
        try {
          w.close();
        } catch (_) {}
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
