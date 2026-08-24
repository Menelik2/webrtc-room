# WebRTC Room (mediasoup SFU)

Professional peer-to-peer **voice, video, and screen-sharing** rooms powered by a **mediasoup** Selective Forwarding Unit (SFU).

![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![mediasoup](https://img.shields.io/badge/mediasoup-3.x-blue) ![License](https://img.shields.io/badge/license-MIT-lightgrey)

## Features

- Multi-party SFU (not mesh) — scales better than pure P2P
- Camera + microphone with mute / pause
- Screen sharing
- Live chat & emoji reactions
- Participants list & basic WebRTC stats
- Device selection (camera / mic / speaker)
- Local recording (WebM download)
- Invite links with room ID + optional remote SFU URL
- Vercel-ready static client; SFU runs on any Node host

## Quick start (local)

```bash
# 1. Install server deps
cd server && npm install && cd ..

# 2. Start SFU + static UI
npm start
# or: cd server && npm start
```

Open **http://localhost:3000**

Join the same room ID from two browsers / devices to test.

## Environment variables (server)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP + WS port |
| `ANNOUNCED_IP` / `MEDIASOUP_ANNOUNCED_IP` | — | Public IP/hostname for ICE (required behind NAT / cloud) |
| `MEDIASOUP_LISTEN_IP` | `0.0.0.0` | Bind address for RTC |
| `MEDIASOUP_MIN_PORT` | `40000` | RTC UDP/TCP range start |
| `MEDIASOUP_MAX_PORT` | `49999` | RTC UDP/TCP range end |
| `MAX_PEERS` | `12` | Max peers per room |

Example (VPS):

```bash
export ANNOUNCED_IP=203.0.113.10
export PORT=3000
cd server && npm start
```

Open firewall for `PORT` (TCP) and `40000-49999` (UDP+TCP).

## Vercel (client only)

The **SFU cannot run on Vercel** (no long-lived WebSocket + UDP). Deploy only the static UI:

- `vercel.json` already points `outputDirectory` to `client/`
- Host `server/` on **Railway**, **Render**, **Fly.io**, **DigitalOcean**, or any VPS

Remote join URL pattern:

```
https://YOUR.vercel.app/?room=standup&sfu=wss://YOUR-SFU-HOST/ws
```

Or set the SFU URL in **Settings** inside the app (saved to `localStorage`).

## Project layout

```
webrtc-room/
├── client/
│   ├── index.html    # UI shell
│   ├── style.css     # Dark pro theme
│   └── app.js        # mediasoup-client + signaling
├── server/
│   ├── package.json
│   └── server.js     # Express + WS + mediasoup SFU
├── scripts/
│   └── validate.js
├── package.json
├── vercel.json
└── README.md
```

## Signaling (WebSocket `/ws`)

JSON messages with optional `requestId` for request/response.

| Client → Server | Server → Client |
|-----------------|-----------------|
| `join` | `joined`, `peerJoined` |
| `createWebRtcTransport` | `webRtcTransportCreated` |
| `connectWebRtcTransport` | `webRtcTransportConnected` |
| `produce` | `produced`, `newProducer` |
| `consume` | `consumed` |
| `resumeConsumer` | `consumerResumed` |
| `pauseProducer` / `resumeProducer` | `producerPaused` / `producerResumed` |
| `closeProducer` | `producerClosed` |
| `chat` | `chat` |
| `reaction` | `reaction` |
| `leave` | `peerLeft` |

## License

MIT
