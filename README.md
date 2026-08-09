# WebRTC Room — SFU Edition (mediasoup)

Private video conference with a Selective Forwarding Unit.

## Quick start

```bash
cd server
npm install
npm start
```

Open http://localhost:3000

## Deploy

- **Client (static):** Vercel Free — this repo root deploys `client/` via `vercel.json`
- **SFU server:** NOT on Vercel. Use Railway, Render, Fly.io, a VPS, or a tunnel (`cloudflared`)

Connect remote UI to SFU:

```
https://your-app.vercel.app/?room=test&sfu=wss://your-sfu-host
```

## Features

Voice/video, screen share, chat, reactions, participants, recording, device selection, TURN support, maintenance mode, admin stats.

## Docs

- `docs/REMOTE_DEVICES.md` — phone / other PC
- `docs/REMOTE_AND_MAINTENANCE.md` — ops
- `docs/ENV_CHECKLIST.md` — environment variables

## License

MIT
