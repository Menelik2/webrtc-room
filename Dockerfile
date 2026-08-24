# WebRTC Room SFU — production image
# Build: docker build -t webrtc-room .
# Run:   docker run --rm -p 3000:3000 -p 40000-40100:40000-40100/udp -e ANNOUNCED_IP=YOUR_PUBLIC_IP webrtc-room

FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev

COPY server/server.js ./server/
COPY client ./client

ENV NODE_ENV=production
ENV PORT=3000
ENV MEDIASOUP_MIN_PORT=40000
ENV MEDIASOUP_MAX_PORT=40100

EXPOSE 3000
EXPOSE 40000-40100/udp
EXPOSE 40000-40100/tcp

WORKDIR /app/server
CMD ["node", "server.js"]
