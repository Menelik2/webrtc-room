# WebRTC Room (mediasoup SFU)

Professional multi-party video / voice / screen-share rooms powered by **mediasoup**.

## Features

- Multi-party audio & video (SFU — scales better than pure mesh)
- Screen sharing
- Mute / camera toggle
- Noise suppression toggle
- In-room chat & emoji reactions
- Participants list
- Network stats
- Device selection (camera / mic / speaker)
- Local recording (WebM download)
- Invite link with room ID
- Works locally or with remote SFU (`?sfu=wss://host`)

## Quick start (local)

```bash
# From repo root
cd server
npm install
npm start
```

Open **http://localhost:3000**

Optional environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP + WS port |
| `LISTEN_IP` | `0.0.0.0` | Bind address |
| `ANNOUNCED_IP` | _(none)_ | Public IP for ICE (required behind NAT/Docker) |
| `RTC_MIN_PORT` | `40000` | mediasoup UDP/TCP range start |
| `RTC_MAX_PORT` | `49999` | mediasoup UDP/TCP range end |

Example with public IP:

```bash
ANNOUNCED_IP=203.0.113.10 npm start
```

## Deploy

### Client (static) on Vercel

The UI deploys from `client/`. The **SFU cannot run on Vercel** (needs long-lived WebSocket + UDP ports).

```bash
# vercel.json already points output to client/
```

### SFU server

Host `server/` on **Railway, Render, Fly.io, a VPS, or Docker**.

Requirements:
- Node.js ≥ 18
- Open TCP port for HTTP/WS
- Open UDP/TCP range `40000–49999` (or your `RTC_*` range) for media
- Set `ANNOUNCED_IP` to the machine’s public IP

Then join with:

```
https://YOUR-CLIENT.vercel.app/?room=standup&sfu=wss://YOUR-SFU-HOST
```

## Project layout

```
webrtc-room/
├── client/
│   ├── index.html    # UI shell
│   ├── style.css     # Dark pro theme
│   └── app.js        # mediasoup-client + full UX
├── server/
│   ├── package.json
│   └── server.js     # Express + WS signaling + mediasoup SFU
├── package.json
├── vercel.json
└── README.md
```

## Architecture (short)

1. Client opens WebSocket to `/ws` and sends `join`.
2. Server creates/gets a mediasoup **Router** per room.
3. Client creates **send** + **recv** WebRtcTransports.
4. Client **produces** mic/camera/screen tracks.
5. Server notifies others → they **consume** those producers.
6. Chat, reactions, rename are pure signaling messages.

## License

MIT
