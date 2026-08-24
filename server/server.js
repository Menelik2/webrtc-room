/**
 * WebRTC Room — mediasoup SFU server
 * Express static + WebSocket signaling + mediasoup workers/routers
 */
'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const mediasoup = require('mediasoup');

const PORT = Number(process.env.PORT) || 3000;
const LISTEN_IP = process.env.LISTEN_IP || '0.0.0.0';
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || undefined; // set to public IP behind NAT

const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 1000,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/VP9',
    clockRate: 90000,
    parameters: {
      'profile-id': 2,
      'x-google-start-bitrate': 1000,
    },
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 1000,
    },
  },
];

const webRtcTransportOptions = {
  listenIps: [{ ip: LISTEN_IP, announcedIp: ANNOUNCED_IP }],
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
  initialAvailableOutgoingBitrate: 1_000_000,
};

/** @type {Map<string, Room>} */
const rooms = new Map();

let worker;

async function createWorker() {
  worker = await mediasoup.createWorker({
    logLevel: 'warn',
    rtcMinPort: Number(process.env.RTC_MIN_PORT) || 40000,
    rtcMaxPort: Number(process.env.RTC_MAX_PORT) || 49999,
  });
  worker.on('died', () => {
    console.error('mediasoup worker died — exiting');
    setTimeout(() => process.exit(1), 1500);
  });
  console.log(`mediasoup worker pid ${worker.pid}`);
}

class Peer {
  constructor(id, name, ws) {
    this.id = id;
    this.name = name;
    this.ws = ws;
    this.sendTransport = null;
    this.recvTransport = null;
    /** @type {Map<string, import('mediasoup').types.Producer>} */
    this.producers = new Map();
    /** @type {Map<string, import('mediasoup').types.Consumer>} */
    this.consumers = new Map();
  }

  send(msg) {
    if (this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close() {
    for (const p of this.producers.values()) {
      try { p.close(); } catch (_) {}
    }
    for (const c of this.consumers.values()) {
      try { c.close(); } catch (_) {}
    }
    try { this.sendTransport?.close(); } catch (_) {}
    try { this.recvTransport?.close(); } catch (_) {}
  }
}

class Room {
  constructor(id, router) {
    this.id = id;
    this.router = router;
    /** @type {Map<string, Peer>} */
    this.peers = new Map();
  }

  addPeer(peer) {
    this.peers.set(peer.id, peer);
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.close();
      this.peers.delete(peerId);
    }
  }

  broadcast(msg, exceptId = null) {
    for (const [id, peer] of this.peers) {
      if (id !== exceptId) peer.send(msg);
    }
  }

  getPeerList() {
    return [...this.peers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      producers: [...p.producers.keys()].map((pid) => {
        const prod = p.producers.get(pid);
        return { id: pid, kind: prod.kind, appData: prod.appData };
      }),
    }));
  }

  empty() {
    return this.peers.size === 0;
  }

  async close() {
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    try { this.router.close(); } catch (_) {}
  }
}

async function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    const router = await worker.createRouter({ mediaCodecs });
    room = new Room(roomId, router);
    rooms.set(roomId, room);
    console.log(`room created: ${roomId}`);
  }
  return room;
}

function generateId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ── HTTP + static ──────────────────────────────────────────────
const app = express();
const clientDir = path.join(__dirname, '..', 'client');
app.use(express.static(clientDir));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  let peer = null;
  let room = null;

  const send = (msg) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  };

  ws.on('message', async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return send({ type: 'error', message: 'invalid json' });
    }

    const { type, requestId } = data;

    try {
      switch (type) {
        case 'join': {
          const name = String(data.name || 'Guest').slice(0, 32);
          const roomId = String(data.roomId || generateId()).slice(0, 32).replace(/[^a-zA-Z0-9_-]/g, '');
          if (!roomId) throw new Error('invalid room id');

          room = await getOrCreateRoom(roomId);
          const peerId = generateId();
          peer = new Peer(peerId, name, ws);
          room.addPeer(peer);

          const rtpCapabilities = room.router.rtpCapabilities;

          send({
            type: 'joined',
            requestId,
            peerId,
            roomId,
            name,
            rtpCapabilities,
            peers: room.getPeerList().filter((p) => p.id !== peerId),
          });

          room.broadcast(
            { type: 'peer-joined', peer: { id: peerId, name, producers: [] } },
            peerId
          );
          break;
        }

        case 'createWebRtcTransport': {
          if (!peer || !room) throw new Error('not joined');
          const { direction } = data; // 'send' | 'recv'
          const transport = await room.router.createWebRtcTransport(webRtcTransportOptions);

          transport.on('dtlsstatechange', (state) => {
            if (state === 'closed') transport.close();
          });

          if (direction === 'send') peer.sendTransport = transport;
          else peer.recvTransport = transport;

          send({
            type: 'createdWebRtcTransport',
            requestId,
            direction,
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
          });
          break;
        }

        case 'connectWebRtcTransport': {
          if (!peer) throw new Error('not joined');
          const { transportId, dtlsParameters } = data;
          const transport =
            peer.sendTransport?.id === transportId
              ? peer.sendTransport
              : peer.recvTransport?.id === transportId
                ? peer.recvTransport
                : null;
          if (!transport) throw new Error('transport not found');
          await transport.connect({ dtlsParameters });
          send({ type: 'connectedWebRtcTransport', requestId, transportId });
          break;
        }

        case 'produce': {
          if (!peer || !room) throw new Error('not joined');
          const { kind, rtpParameters, appData } = data;
          if (!peer.sendTransport) throw new Error('no send transport');

          const producer = await peer.sendTransport.produce({
            kind,
            rtpParameters,
            appData: appData || {},
          });

          peer.producers.set(producer.id, producer);

          producer.on('transportclose', () => {
            peer.producers.delete(producer.id);
          });

          send({ type: 'produced', requestId, id: producer.id });

          room.broadcast(
            {
              type: 'new-producer',
              peerId: peer.id,
              producerId: producer.id,
              kind,
              appData: producer.appData,
            },
            peer.id
          );
          break;
        }

        case 'consume': {
          if (!peer || !room) throw new Error('not joined');
          const { producerId, rtpCapabilities } = data;
          if (!peer.recvTransport) throw new Error('no recv transport');

          if (!room.router.canConsume({ producerId, rtpCapabilities })) {
            throw new Error('cannot consume');
          }

          const consumer = await peer.recvTransport.consume({
            producerId,
            rtpCapabilities,
            paused: false,
          });

          peer.consumers.set(consumer.id, consumer);

          consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
          consumer.on('producerclose', () => {
            peer.consumers.delete(consumer.id);
            peer.send({ type: 'consumer-closed', consumerId: consumer.id });
          });

          send({
            type: 'consumed',
            requestId,
            id: consumer.id,
            producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            appData: consumer.appData,
            producerPaused: consumer.producerPaused,
          });
          break;
        }

        case 'resumeConsumer': {
          if (!peer) throw new Error('not joined');
          const consumer = peer.consumers.get(data.consumerId);
          if (consumer) await consumer.resume();
          send({ type: 'consumerResumed', requestId });
          break;
        }

        case 'closeProducer': {
          if (!peer || !room) throw new Error('not joined');
          const producer = peer.producers.get(data.producerId);
          if (producer) {
            producer.close();
            peer.producers.delete(data.producerId);
            room.broadcast(
              { type: 'producer-closed', peerId: peer.id, producerId: data.producerId },
              peer.id
            );
          }
          send({ type: 'producerClosed', requestId });
          break;
        }

        case 'chat': {
          if (!peer || !room) throw new Error('not joined');
          const text = String(data.text || '').slice(0, 500);
          if (!text) break;
          room.broadcast({
            type: 'chat',
            peerId: peer.id,
            name: peer.name,
            text,
            ts: Date.now(),
          });
          break;
        }

        case 'reaction': {
          if (!peer || !room) throw new Error('not joined');
          const emoji = String(data.emoji || '').slice(0, 8);
          if (!emoji) break;
          room.broadcast({
            type: 'reaction',
            peerId: peer.id,
            name: peer.name,
            emoji,
          });
          break;
        }

        case 'rename': {
          if (!peer || !room) throw new Error('not joined');
          peer.name = String(data.name || peer.name).slice(0, 32);
          room.broadcast({ type: 'peer-renamed', peerId: peer.id, name: peer.name });
          send({ type: 'renamed', requestId, name: peer.name });
          break;
        }

        case 'getRouterRtpCapabilities': {
          if (!room) throw new Error('not joined');
          send({
            type: 'routerRtpCapabilities',
            requestId,
            rtpCapabilities: room.router.rtpCapabilities,
          });
          break;
        }

        case 'ping': {
          send({ type: 'pong', requestId, t: Date.now() });
          break;
        }

        default:
          send({ type: 'error', requestId, message: `unknown type: ${type}` });
      }
    } catch (err) {
      console.error(`[${type}]`, err.message);
      send({ type: 'error', requestId, message: err.message || 'server error' });
    }
  });

  ws.on('close', () => {
    if (peer && room) {
      const peerId = peer.id;
      room.removePeer(peerId);
      room.broadcast({ type: 'peer-left', peerId });
      if (room.empty()) {
        room.close();
        rooms.delete(room.id);
        console.log(`room closed: ${room.id}`);
      }
    }
  });

  ws.on('error', (err) => console.error('ws error', err.message));
});

async function main() {
  await createWorker();
  server.listen(PORT, LISTEN_IP, () => {
    console.log(`WebRTC Room SFU listening on http://${LISTEN_IP}:${PORT}`);
    console.log(`WebSocket path: /ws`);
    if (ANNOUNCED_IP) console.log(`announced IP: ${ANNOUNCED_IP}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
