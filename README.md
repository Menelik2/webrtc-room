# WebRTC Room (mediasoup SFU)

Professional multi-party **voice, video, and screen-sharing** rooms powered by a **mediasoup** Selective Forwarding Unit (SFU).

![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![mediasoup](https://img.shields.io/badge/mediasoup-3.x-blue) ![License](https://img.shields.io/badge/license-MIT-lightgrey)

## Features

- Multi-party **SFU** (not mesh) — better scale than pure P2P
- Camera + microphone with mute / pause
- Screen sharing
- Live chat & emoji reactions
- Participants list & basic WebRTC stats
- Device selection (camera / mic / speaker)
- Local recording (WebM download)
- Invite links with room ID + optional remote SFU URL
- Vercel-ready static client; SFU on any Node host or Docker

## Quick start (local)

```bash
cd server && npm install && cd ..
npm start
```

Open **http://localhost:3000** — join the same room ID from two browsers to test.

## Environment variables

See [`.env.example`](.env.example).

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP + WebSocket port |
| `ANNOUNCED_IP` | — | Public IP/hostname for ICE (**required** behind NAT / cloud) |
| `MEDIASOUP_LISTEN_IP` | `0.0.0.0` | RTC bind address |
| `MEDIASOUP_MIN_PORT` | `40000` | RTC port range start |
| `MEDIASOUP_MAX_PORT` | `49999` | RTC port range end |
| `MAX_PEERS` | `12` | Max peers per room |

```bash
export ANNOUNCED_IP=203.0.113.10
cd server && npm start
```

Open firewall: TCP `PORT`, and UDP+TCP `40000–49999` (or your configured range).

## Docker

```bash
docker build -t webrtc-room .
docker run --rm -p 3000:3000 -p 40000-40100:40000-40100/udp -p 40000-40100:40000-40100/tcp \
  -e ANNOUNCED_IP=YOUR_PUBLIC_IP \
  webrtc-room
```

## Vercel (client only)

The **SFU cannot run on Vercel**. Deploy the static UI from `client/` (`vercel.json` is configured). Host `server/` on Railway, Render, Fly.io, a VPS, or Docker.

Remote join:

```
https://YOUR.vercel.app/?room=standup&sfu=wss://YOUR-SFU-HOST/ws
```

Or set the SFU URL under **Settings** in the app (stored in `localStorage`).

## Project layout

```
webrtc-room/
├── client/           # Static UI (HTML/CSS/JS + mediasoup-client)
├── server/           # Express + WS + mediasoup SFU
├── scripts/validate.js
├── Dockerfile
├── vercel.json
└── README.md
```

## Signaling (WebSocket `/ws`)

JSON messages; client requests include `requestId` for matched replies.

| Client → Server | Server → Client |
|-----------------|-----------------|
| `join` | `joined`, `peerJoined` |
| `createWebRtcTransport` | `webRtcTransportCreated` |
| `connectWebRtcTransport` | `webRtcTransportConnected` |
| `produce` | `produced`, `newProducer` |
| `consume` / `resumeConsumer` | `consumed` / `consumerResumed` |
| `pauseProducer` / `resumeProducer` / `closeProducer` | `producerPaused` / `producerResumed` / `producerClosed` |
| `chat` / `reaction` | `chat` / `reaction` |
| `leave` | `peerLeft` |

Health: `GET /health`

## License

MIT
