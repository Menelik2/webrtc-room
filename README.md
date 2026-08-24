# WebRTC Room (mediasoup SFU)

Professional multi-party **voice, video, and screen-sharing** rooms powered by a **mediasoup** Selective Forwarding Unit (SFU).

![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![mediasoup](https://img.shields.io/badge/mediasoup-3.x-blue) ![License](https://img.shields.io/badge/license-MIT-lightgrey)

## Features

- Multi-party **SFU** (not mesh)
- Camera + microphone with mute / pause
- Screen sharing
- Live chat & emoji reactions
- Participants list & WebRTC stats
- Device selection
- Local recording (WebM)
- Invite links (`?room=` + optional `?sfu=`)
- Docker + Railway / Render / Fly configs
- Vercel-ready static client

## Quick start (local)

```bash
cd server && npm install && cd ..
npm start
```

Open **http://localhost:3000** — use the same room ID in two browsers.

## Environment

See [`.env.example`](.env.example).

| Variable | Default | Notes |
|----------|---------|--------|
| `PORT` | `3000` | HTTP + WS |
| `ANNOUNCED_IP` | — | **Required** on cloud/NAT (public IP or hostname) |
| `MEDIASOUP_MIN_PORT` / `MAX` | `40000` / `49999` | Open UDP+TCP in firewall |
| `MAX_PEERS` | `12` | Per room |

## Deploy SFU

### Docker

```bash
docker build -t webrtc-room .
docker run --rm -p 3000:3000 -p 40000-40100:40000-40100/udp -p 40000-40100:40000-40100/tcp \
  -e ANNOUNCED_IP=YOUR_PUBLIC_IP webrtc-room
```

### Railway

1. New project → Deploy from GitHub → `Menelik2/webrtc-room`
2. Use `railway.toml` (or set start: `cd server && npm install && node server.js`)
3. Set `ANNOUNCED_IP` to the public hostname Railway gives you
4. Health check: `/health`

### Render

Use [`render.yaml`](render.yaml) blueprint, then set `ANNOUNCED_IP` to `your-service.onrender.com`.

> Free/web plans may not expose the mediasoup UDP range well. Prefer a VPS or Docker host with open RTC ports for production video.

### Fly.io

```bash
fly launch
fly secrets set ANNOUNCED_IP=YOUR_APP.fly.dev
fly deploy
```

## Deploy client (Vercel)

`vercel.json` serves `client/` as static. The SFU must run elsewhere.

Join remotely:

```
https://YOUR.vercel.app/?room=standup&sfu=wss://YOUR-SFU-HOST/ws
```

## Project layout

```
client/     UI (HTML/CSS/JS + mediasoup-client CDN)
server/     Express + WS + mediasoup
scripts/    validate.js
Dockerfile  railway.toml  render.yaml  fly.toml
```

## API

- `GET /health` — rooms, peers, workers, uptime
- `WS /ws` — signaling (join, transports, produce/consume, chat, reactions)

## License

MIT
