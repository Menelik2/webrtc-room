# Remote use and maintenance

Point the client at a remote SFU with `?sfu=wss://host`, Settings, or `window.SFU_URL`.

## Health

`GET /health` — public liveness

## Admin (set ADMIN_TOKEN on server)

- `GET /api/admin/stats`
- `POST /api/admin/maintenance` `{ "enabled": true }`
- `POST /api/admin/close-room` `{ "roomId": "..." }`

Helper: `scripts/admin.sh`
