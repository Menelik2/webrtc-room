# WebRTC Room (mediasoup SFU)

## Quick start

```bash
cd server && npm install && npm start
```

Open http://localhost:3000

## Vercel (client only)

Static UI deploys from `client/`. The **SFU cannot run on Vercel** — host `server/` on Railway/Render/Fly/VPS or use a tunnel.

Remote join:

```
https://YOUR.vercel.app/?room=test&sfu=wss://YOUR-SFU-HOST
```

## License

MIT
