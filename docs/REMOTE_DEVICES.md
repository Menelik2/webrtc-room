# Use from another computer or phone

## Same Wi-Fi

1. On the PC running the SFU: `cd server && npm install && npm start`
2. Find LAN IP (e.g. 192.168.1.50)
3. On phone/other PC open: `http://192.168.1.50:3000/?room=myroom`
4. Same Room ID on all devices

## Internet / mobile data

Use a tunnel or VPS:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

Open the https URL on all devices with the same room id.

## Vercel UI + remote SFU

```
https://your-app.vercel.app/?room=myroom&sfu=wss://sfu.example.com
```

Copy invite link in the call UI includes room and sfu params.
