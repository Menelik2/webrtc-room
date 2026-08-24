# WebRTC Room (mediasoup SFU)

Professional multi-party **voice, video, and screen-sharing** rooms powered by a **mediasoup** Selective Forwarding Unit (SFU).

![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![mediasoup](https://img.shields.io/badge/mediasoup-3.x-blue) ![License](https://img.shields.io/badge/license-MIT-lightgrey)

## Features

- Multi-party **SFU** architecture (not peer mesh)
- Camera + microphone with mute / pause
- Screen sharing
- Optional **room PIN** (first joiner sets; others must match)
- Live chat & emoji reactions
- Participants list & network stats panel
- Device selection with **mid-call hot-swap** (replaceTrack)
- Local recording (WebM)
- Keyboard shortcuts: **M** mic · **C** cam · **S** screen · **Esc** close panels
- Invite links (`?room=` + optional `?sfu=`)
- Docker + Railway / Render / Fly configs
- Vercel-ready static client

## Quick start (local)

```bash
cd server && npm install && cd ..
npm start
# or: node server/server.js
```

Open **http://localhost:3000** — use the same room ID in two browsers (or tabs).

```bash
# Health check
curl -s http://localhost:3000/health
```

## Environment

See [`.env.example`](.env.example). Copy to `server/.env` or export before start.

| Variable | Default | Notes |
|----------|---------|--------|
| `PORT` | `3000` | HTTP + WebSocket |
| `ANNOUNCED_IP` | auto LAN IPv4 | **Set explicitly on cloud/NAT** (public IP or hostname) |
| `MEDIASOUP_LISTEN_IP` | `0.0.0.0` | Bind address for RTC |
| `MEDIASOUP_MIN_PORT` / `MAX` | `40000` / `49999` | Open **UDP + TCP** in firewall |
| `MAX_PEERS` | `12` | Max peers per room |

## WebRTC ICE (important)

mediasoup uses **ICE-Lite**: the SFU does **not** gather candidates the way a browser does. It advertises **fixed host candidates** from its listen config.

| Side | Behavior |
|------|----------|
| **SFU** | Builds candidates from `listenInfos` + `announcedAddress` (`ANNOUNCED_IP`) |
| **Browser** | Gathers local host/srflx candidates and checks connectivity **to** the SFU |

### How candidates are produced

1. Server creates a `WebRtcTransport` with UDP + TCP `listenInfos`.
2. If `ANNOUNCED_IP` is set, that address is put in the ICE candidate `ip` field (required behind NAT/cloud).
3. If unset, the server tries the first non-internal IPv4 (works on many LAN setups).
4. Client receives `iceParameters` + `iceCandidates` + `dtlsParameters` over `/ws` and passes them into `mediasoup-client` transports.

### Health payload (ICE summary)

```bash
curl -s http://localhost:3000/health | jq .ice
```

Example:

```json
{
  "mode": "ice-lite",
  "listenIp": "0.0.0.0",
  "announcedAddress": "203.0.113.10",
  "rtcPorts": "40000-49999"
}
```

Server logs also print candidates when a transport is created:

```text
[ice] transport <id> candidates: [{"ip":"…","protocol":"udp","port":40xxx,"type":"host"}, …]
```

### ICE troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Connects locally, fails remotely | Missing public address | Set `ANNOUNCED_IP` to public IP or hostname |
| `connectionState: failed` | RTC ports blocked | Open UDP+TCP `40000–49999` (or your range) |
| Works on Wi‑Fi, fails on mobile data | Symmetric NAT | Deploy SFU on public IP; consider TURN for extreme cases |
| Candidates show `0.0.0.0` | No announced IP | Set `ANNOUNCED_IP` |

> **Note:** Strict corporate/mobile networks may still need a **TURN** server. mediasoup does not embed TURN; you would add `iceServers` on the client if required.

## Room PIN

- Leave **Room PIN** blank for an open room.
- First peer in an empty room may set a PIN.
- Later peers must send the same PIN or join fails with `invalid_pin`.

## Deploy SFU

### Docker

```bash
docker build -t webrtc-room .
docker run --rm -p 3000:3000 \
  -p 40000-40100:40000-40100/udp \
  -p 40000-40100:40000-40100/tcp \
  -e ANNOUNCED_IP=YOUR_PUBLIC_IP \
  webrtc-room
```

### Railway

1. New project → Deploy from GitHub → this repo (branch `root` if needed).
2. Use [`railway.toml`](railway.toml) or start command: `cd server && npm install && node server.js`.
3. Set `ANNOUNCED_IP` to the public hostname Railway assigns.
4. Health check path: `/health`.

### Render

Use [`render.yaml`](render.yaml), then set `ANNOUNCED_IP` to `your-service.onrender.com`.

> Free/web plans often cannot expose the mediasoup UDP range reliably. Prefer a VPS or Docker host with open RTC ports for production A/V.

### Fly.io

```bash
fly launch
fly secrets set ANNOUNCED_IP=YOUR_APP.fly.dev
fly deploy
```

See [`fly.toml`](fly.toml).

## Deploy client only (Vercel)

[`vercel.json`](vercel.json) serves `client/` as static files. The SFU must run elsewhere.

Join remotely:

```text
https://YOUR.vercel.app/?room=standup&sfu=wss://YOUR-SFU-HOST/ws
```

Or set **SFU URL** in the in-app Settings panel (stored in `localStorage`).

## Project layout

```text
client/          UI (HTML/CSS/JS + mediasoup-client CDN)
  app.js         Signaling, media, ICE transport setup
  index.html     Lobby + call UI
  style.css
server/
  server.js      Express + WebSocket + mediasoup workers/routers
  package.json
scripts/
  validate.js
Dockerfile  railway.toml  render.yaml  fly.toml  vercel.json
```

## Signaling API

| Endpoint | Description |
|----------|-------------|
| `GET /health` | rooms, peers, workers, ICE summary, uptime |
| `WS /ws` | JSON signaling |

### Main message types

| Client → server | Server → client |
|-----------------|-----------------|
| `join` | `joined` / `error` |
| `createWebRtcTransport` | `webRtcTransportCreated` (`iceParameters`, `iceCandidates`, `dtlsParameters`) |
| `connectWebRtcTransport` | `webRtcTransportConnected` |
| `produce` / `consume` / `resumeConsumer` | `produced` / `consumed` / … |
| `pauseProducer` / `resumeProducer` / `closeProducer` | `ok` + peer events |
| `chat` / `reaction` / `updateDisplayName` | broadcast events |
| `leave` / `ping` | `left` / `pong` |

## License

MIT — see [LICENSE](LICENSE).
