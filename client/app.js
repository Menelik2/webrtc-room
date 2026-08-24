/**
 * WebRTC Room — client (mediasoup-client)
 * Full lobby, media, screen share, chat, reactions, participants, stats, settings
 */
(() => {
  'use strict';

  const { Device } = window.mediasoupClient || {};
  if (!Device) {
    console.error('mediasoup-client failed to load');
    document.body.innerHTML =
      '<p style="color:#fff;padding:2rem;font-family:system-ui">Failed to load mediasoup-client. Check network / CDN.</p>';
    return;
  }

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  const lobby = $('#lobby');
  const call = $('#call');
  const joinForm = $('#join-form');
  const displayNameInput = $('#display-name');
  const roomIdInput = $('#room-id');
  const joinBtn = $('#join-btn');
  const currentRoomEl = $('#current-room');
  const peerCountEl = $('#peer-count');
  const localVideo = $('#local-video');
  const localName = $('#local-name');
  const localMuted = $('#local-muted');
  const videosGrid = $('#videos-grid');
  const participantsList = $('#participants-list');
  const chatMessages = $('#chat-messages');
  const chatForm = $('#chat-form');
  const chatInput = $('#chat-input');
  const statsContent = $('#stats-content');
  const reactionsBar = $('#reactions-bar');
  const floatingReactions = $('#floating-reactions');
  const settingsModal = $('#settings-modal');
  const selectCamera = $('#select-camera');
  const selectMic = $('#select-mic');
  const selectSpeaker = $('#select-speaker');
  const mirrorLocal = $('#mirror-local');
  const settingsName = $('#settings-name');
  const settingsSfuUrl = $('#settings-sfu-url');
  const recordingIndicator = $('#recording-indicator');
  const toasts = $('#toasts');

  let ws = null;
  let device = null;
  let sendTransport = null;
  let recvTransport = null;
  let localStream = null;
  let screenStream = null;
  let audioProducer = null;
  let videoProducer = null;
  let screenProducer = null;
  let peerId = null;
  let roomId = null;
  let displayName = 'You';
  let micEnabled = true;
  let camEnabled = true;
  let noiseSuppression = true;
  let mediaRecorder = null;
  let recordedChunks = [];
  let statsTimer = null;
  let pingTimer = null;
  let meterTimer = null;

  const peers = new Map();
  const consumers = new Map();
  const producerToConsumer = new Map();

  let requestSeq = 0;
  const pending = new Map();

  function toast(msg, ms = 2800) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    toasts.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function genRoomId() {
    return Math.random().toString(36).slice(2, 8);
  }

  function qs(name) {
    return new URLSearchParams(location.search).get(name);
  }

  function defaultSfuUrl() {
    const fromQuery = qs('sfu');
    if (fromQuery) return fromQuery;
    const stored = localStorage.getItem('sfuUrl');
    if (stored) return stored.includes('/ws') ? stored : stored.replace(/\/?$/, '') + '/ws';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  function request(type, payload = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== 1) {
        reject(new Error('Not connected'));
        return;
      }
      const requestId = `r${++requestSeq}`;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Timeout: ${type}`));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      ws.send(JSON.stringify({ type, requestId, ...payload }));
    });
  }

  function handleServerMessage(msg) {
    if (msg.requestId && pending.has(msg.requestId)) {
      const { resolve, reject, timer } = pending.get(msg.requestId);
      pending.delete(msg.requestId);
      clearTimeout(timer);
      if (msg.type === 'error') reject(new Error(msg.error || 'error'));
      else resolve(msg);
      return;
    }

    switch (msg.type) {
      case 'peerJoined':
        ensurePeer(msg.peer.id, msg.peer.displayName);
        updatePeerCount();
        updateParticipants();
        toast(`${msg.peer.displayName} joined`);
        break;
      case 'peerLeft':
        removePeer(msg.peerId);
        updatePeerCount();
        updateParticipants();
        toast(`${msg.displayName || 'Someone'} left`);
        break;
      case 'peerUpdated':
        if (peers.has(msg.peerId)) {
          peers.get(msg.peerId).displayName = msg.displayName;
          updatePeerLabels(msg.peerId);
          updateParticipants();
        }
        break;
      case 'newProducer':
        consumeProducer(msg.producerId, msg.peerId, msg.displayName, msg.kind, msg.appData);
        break;
      case 'producerClosed':
        closeConsumerForProducer(msg.producerId);
        break;
      case 'consumerClosed':
        closeConsumer(msg.consumerId);
        break;
      case 'chat':
        appendChat(msg.displayName, msg.text, msg.peerId === peerId);
        break;
      case 'reaction':
        showFloatingReaction(msg.emoji, msg.displayName);
        break;
      default:
        break;
    }
  }

  function connectWs(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const t = setTimeout(() => {
        socket.close();
        reject(new Error('WebSocket connect timeout'));
      }, 10000);

      socket.onopen = () => {
        clearTimeout(t);
        ws = socket;
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(t);
        reject(new Error('WebSocket error — is the SFU running?'));
      };
      socket.onmessage = (ev) => {
        try {
          handleServerMessage(JSON.parse(ev.data));
        } catch (e) {
          console.warn('bad message', e);
        }
      };
      socket.onclose = () => {
        if (call && !call.classList.contains('hidden')) {
          toast('Disconnected from SFU');
          leaveRoom(true);
        }
        ws = null;
      };
    });
  }

  async function getLocalMedia() {
    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: noiseSuppression,
        autoGainControl: true,
      },
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
    };
    try {
      localStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      console.warn('Cam failed, trying audio only', e);
      localStream = await navigator.mediaDevices.getUserMedia({ audio: constraints.audio });
      camEnabled = false;
    }
    localVideo.srcObject = localStream;
    localVideo.classList.toggle('mirror', mirrorLocal.checked);
    applyMicCamState();
    startLocalMeter();
  }

  function applyMicCamState() {
    if (!localStream) return;
    localStream.getAudioTracks().forEach((t) => (t.enabled = micEnabled));
    localStream.getVideoTracks().forEach((t) => (t.enabled = camEnabled));
    localMuted.classList.toggle('hidden', micEnabled);
    $('#toggle-mic')?.classList.toggle('danger-active', !micEnabled);
    $('#toggle-cam')?.classList.toggle('danger-active', !camEnabled);
  }

  function startLocalMeter() {
    stopLocalMeter();
    const bar = document.querySelector('#local-meter .meter-bar');
    if (!bar || !localStream?.getAudioTracks().length) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaStreamSource(localStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      meterTimer = setInterval(() => {
        if (!micEnabled) {
          bar.style.height = '0%';
          return;
        }
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length / 255;
        bar.style.height = Math.min(100, Math.round(avg * 140)) + '%';
      }, 80);
    } catch (_) {}
  }

  function stopLocalMeter() {
    if (meterTimer) clearInterval(meterTimer);
    meterTimer = null;
  }

  async function joinRoom(name, rid) {
    joinBtn.disabled = true;
    joinBtn.textContent = 'Connecting…';

    try {
      displayName = name;
      roomId = rid || genRoomId();

      let sfuUrl = settingsSfuUrl.value.trim() || defaultSfuUrl();
      if (!sfuUrl) {
        throw new Error('SFU URL required. Set it in Settings or use ?sfu=wss://host/ws');
      }
      if (!sfuUrl.includes('/ws')) {
        sfuUrl = sfuUrl.replace(/\/?$/, '') + '/ws';
      }
      localStorage.setItem('sfuUrl', sfuUrl.replace(/\/ws$/, ''));

      await connectWs(sfuUrl);

      const joined = await request('join', { roomId, displayName: name });

      peerId = joined.peerId;
      roomId = joined.roomId;
      displayName = joined.displayName;

      device = new Device();
      await device.load({ routerRtpCapabilities: joined.rtpCapabilities });

      sendTransport = await createTransport('send');
      recvTransport = await createTransport('recv');

      await getLocalMedia();

      if (localStream.getAudioTracks().length) {
        audioProducer = await sendTransport.produce({
          track: localStream.getAudioTracks()[0],
          appData: { source: 'mic' },
        });
      }
      if (localStream.getVideoTracks().length && camEnabled) {
        videoProducer = await sendTransport.produce({
          track: localStream.getVideoTracks()[0],
          encodings: [
            { maxBitrate: 100000, scaleResolutionDownBy: 4 },
            { maxBitrate: 300000, scaleResolutionDownBy: 2 },
            { maxBitrate: 900000 },
          ],
          codecOptions: { videoGoogleStartBitrate: 1000 },
          appData: { source: 'camera' },
        });
      }

      for (const p of joined.peers || []) ensurePeer(p.id, p.displayName);
      for (const ep of joined.existingProducers || []) {
        await consumeProducer(ep.producerId, ep.peerId, ep.displayName, ep.kind, ep.appData);
      }

      localName.textContent = displayName;
      currentRoomEl.textContent = roomId;
      lobby.classList.add('hidden');
      call.classList.remove('hidden');
      updatePeerCount();
      updateParticipants();
      startStats();
      startPing();

      const u = new URL(location.href);
      u.searchParams.set('room', roomId);
      history.replaceState(null, '', u);

      toast(`Joined room ${roomId}`);
    } catch (err) {
      console.error(err);
      toast(err.message || 'Join failed');
      cleanupMedia();
      if (ws) {
        try { ws.close(); } catch (_) {}
        ws = null;
      }
    } finally {
      joinBtn.disabled = false;
      joinBtn.textContent = 'Join Room';
    }
  }

  async function createTransport(direction) {
    const info = await request('createWebRtcTransport', { direction });
    const transport =
      direction === 'send'
        ? device.createSendTransport(info)
        : device.createRecvTransport(info);

    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      request('connectWebRtcTransport', {
        transportId: transport.id,
        dtlsParameters,
      })
        .then(() => callback())
        .catch(errback);
    });

    if (direction === 'send') {
      transport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
        try {
          const { id } = await request('produce', {
            transportId: transport.id,
            kind,
            rtpParameters,
            appData,
          });
          callback({ id });
        } catch (e) {
          errback(e);
        }
      });
    }

    transport.on('connectionstatechange', (state) => {
      if (state === 'failed' || state === 'closed') {
        console.warn(`Transport ${direction} state:`, state);
      }
    });

    return transport;
  }

  async function consumeProducer(producerId, remotePeerId, remoteName, kind, appData = {}) {
    if (!device || !recvTransport) return;
    if (producerToConsumer.has(producerId)) return;

    ensurePeer(remotePeerId, remoteName);

    try {
      const consumed = await request('consume', {
        transportId: recvTransport.id,
        producerId,
        rtpCapabilities: device.rtpCapabilities,
      });

      const consumer = await recvTransport.consume({
        id: consumed.id,
        producerId: consumed.producerId,
        kind: consumed.kind,
        rtpParameters: consumed.rtpParameters,
      });

      consumers.set(consumer.id, consumer);
      producerToConsumer.set(producerId, consumer.id);

      const peer = peers.get(remotePeerId);
      if (peer) peer.consumers.set(consumer.id, consumer);

      const source = (appData && appData.source) || kind;
      attachRemoteTrack(remotePeerId, remoteName, consumer.track, source);

      await request('resumeConsumer', { consumerId: consumer.id });
      updateParticipants();
    } catch (err) {
      console.error('consume failed', producerId, err);
    }
  }

  function ensurePeer(id, name) {
    if (!peers.has(id)) {
      peers.set(id, {
        displayName: name || 'Guest',
        tiles: new Map(),
        consumers: new Map(),
      });
    } else if (name) {
      peers.get(id).displayName = name;
    }
  }

  function attachRemoteTrack(remotePeerId, remoteName, track, source) {
    const peer = peers.get(remotePeerId);
    if (!peer) return;

    let tile = peer.tiles.get(source);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'video-tile remote';
      tile.dataset.peerId = remotePeerId;
      tile.dataset.source = source;
      tile.innerHTML = `
        <video autoplay playsinline></video>
        <div class="tile-overlay">
          <div class="tile-label">
            <span class="remote-name">${escapeHtml(remoteName)}</span>
            <span class="source-badge">${source === 'screen' ? '🖥️' : ''}</span>
          </div>
        </div>`;
      videosGrid.appendChild(tile);
      peer.tiles.set(source, tile);
    }

    const video = tile.querySelector('video');
    let stream = video.srcObject;
    if (!stream) {
      stream = new MediaStream();
      video.srcObject = stream;
    }
    stream.getTracks().filter((t) => t.kind === track.kind).forEach((t) => {
      stream.removeTrack(t);
    });
    stream.addTrack(track);
    video.play().catch(() => {});
  }

  function updatePeerLabels(id) {
    const peer = peers.get(id);
    if (!peer) return;
    for (const tile of peer.tiles.values()) {
      const el = tile.querySelector('.remote-name');
      if (el) el.textContent = peer.displayName;
    }
  }

  function closeConsumerForProducer(producerId) {
    const cid = producerToConsumer.get(producerId);
    if (cid) closeConsumer(cid);
    producerToConsumer.delete(producerId);
  }

  function closeConsumer(consumerId) {
    const consumer = consumers.get(consumerId);
    if (!consumer) return;
    try { consumer.close(); } catch (_) {}
    consumers.delete(consumerId);

    for (const peer of peers.values()) {
      peer.consumers.delete(consumerId);
      for (const [source, tile] of [...peer.tiles]) {
        const video = tile.querySelector('video');
        const stream = video?.srcObject;
        if (stream) {
          const live = stream.getTracks().filter((t) => t.readyState === 'live');
          if (live.length === 0) {
            tile.remove();
            peer.tiles.delete(source);
          }
        }
      }
    }
  }

  function removePeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    for (const tile of peer.tiles.values()) tile.remove();
    for (const c of peer.consumers.values()) {
      try { c.close(); } catch (_) {}
      consumers.delete(c.id);
    }
    peers.delete(id);
  }

  function cleanupMedia() {
    stopStats();
    stopPing();
    stopLocalMeter();
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try { mediaRecorder.stop(); } catch (_) {}
    }
    mediaRecorder = null;
    recordedChunks = [];
    recordingIndicator.classList.add('hidden');

    [audioProducer, videoProducer, screenProducer].forEach((p) => {
      try { p?.close(); } catch (_) {}
    });
    audioProducer = videoProducer = screenProducer = null;

    try { sendTransport?.close(); } catch (_) {}
    try { recvTransport?.close(); } catch (_) {}
    sendTransport = recvTransport = null;

    for (const c of consumers.values()) {
      try { c.close(); } catch (_) {}
    }
    consumers.clear();
    producerToConsumer.clear();

    for (const peer of peers.values()) {
      for (const tile of peer.tiles.values()) tile.remove();
    }
    peers.clear();

    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    if (screenStream) {
      screenStream.getTracks().forEach((t) => t.stop());
      screenStream = null;
    }
    localVideo.srcObject = null;
    device = null;
  }

  function leaveRoom(fromClose = false) {
    if (!fromClose && ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: 'leave' }));
      } catch (_) {}
    }
    cleanupMedia();
    if (ws) {
      try { ws.close(); } catch (_) {}
      ws = null;
    }
    peerId = null;
    call.classList.add('hidden');
    lobby.classList.remove('hidden');
    $$('.side-panel').forEach((p) => p.classList.add('hidden'));
    reactionsBar.classList.add('hidden');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&')
      .replace(/</g, '<')
      .replace(/>/g, '>')
      .replace(/"/g, '"');
  }

  function updatePeerCount() {
    peerCountEl.textContent = String(peers.size + 1);
  }

  function updateParticipants() {
    participantsList.innerHTML = '';
    const add = (name, isLocal) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(name)}${isLocal ? ' <span class="muted">(you)</span>' : ''}</span>`;
      participantsList.appendChild(li);
    };
    add(displayName, true);
    for (const p of peers.values()) add(p.displayName, false);
  }

  function appendChat(name, text) {
    const div = document.createElement('div');
    div.className = 'chat-msg';
    div.innerHTML = `<div class="who">${escapeHtml(name)}</div><div class="body">${escapeHtml(text)}</div>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function showFloatingReaction(emoji) {
    const el = document.createElement('div');
    el.textContent = emoji;
    el.style.cssText =
      'position:absolute;font-size:2rem;left:' +
      (20 + Math.random() * 60) +
      '%;bottom:20%;opacity:1;transition:all 2.2s ease-out;pointer-events:none;z-index:30;';
    floatingReactions.appendChild(el);
    requestAnimationFrame(() => {
      el.style.bottom = '70%';
      el.style.opacity = '0';
      el.style.transform = 'scale(1.4)';
    });
    setTimeout(() => el.remove(), 2300);
  }

  async function toggleMic() {
    micEnabled = !micEnabled;
    applyMicCamState();
    if (audioProducer) {
      if (micEnabled) {
        await audioProducer.resume();
        await request('resumeProducer', { producerId: audioProducer.id }).catch(() => {});
      } else {
        await audioProducer.pause();
        await request('pauseProducer', { producerId: audioProducer.id }).catch(() => {});
      }
    }
  }

  async function toggleCam() {
    camEnabled = !camEnabled;
    applyMicCamState();
    if (videoProducer) {
      if (camEnabled) {
        await videoProducer.resume();
        await request('resumeProducer', { producerId: videoProducer.id }).catch(() => {});
      } else {
        await videoProducer.pause();
        await request('pauseProducer', { producerId: videoProducer.id }).catch(() => {});
      }
    } else if (camEnabled && localStream?.getVideoTracks().length && sendTransport) {
      videoProducer = await sendTransport.produce({
        track: localStream.getVideoTracks()[0],
        appData: { source: 'camera' },
      });
    }
  }

  async function toggleScreen() {
    const btn = $('#toggle-screen');
    if (screenProducer) {
      try {
        await request('closeProducer', { producerId: screenProducer.id });
      } catch (_) {}
      try { screenProducer.close(); } catch (_) {}
      screenProducer = null;
      if (screenStream) {
        screenStream.getTracks().forEach((t) => t.stop());
        screenStream = null;
      }
      btn?.classList.remove('active');
      toast('Screen share stopped');
      return;
    }
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 15 },
        audio: false,
      });
      const track = screenStream.getVideoTracks()[0];
      track.onended = () => {
        if (screenProducer) toggleScreen();
      };
      screenProducer = await sendTransport.produce({
        track,
        appData: { source: 'screen' },
      });
      btn?.classList.add('active');
      toast('Sharing screen');
    } catch (e) {
      if (e.name !== 'NotAllowedError') toast('Screen share failed');
    }
  }

  function toggleNoise() {
    noiseSuppression = !noiseSuppression;
    $('#toggle-noise')?.classList.toggle('active', noiseSuppression);
    toast(noiseSuppression ? 'Noise suppression on (applies next join)' : 'Noise suppression off (applies next join)');
  }

  function toggleRecord() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      return;
    }
    if (!localStream) {
      toast('No media to record');
      return;
    }
    recordedChunks = [];
    try {
      mediaRecorder = new MediaRecorder(localStream, { mimeType: 'video/webm;codecs=vp9,opus' });
    } catch {
      mediaRecorder = new MediaRecorder(localStream);
    }
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = () => {
      recordingIndicator.classList.add('hidden');
      $('#toggle-record')?.classList.remove('danger-active');
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `room-${roomId}-${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(url);
      toast('Recording saved');
      mediaRecorder = null;
    };
    mediaRecorder.start(1000);
    recordingIndicator.classList.remove('hidden');
    $('#toggle-record')?.classList.add('danger-active');
    toast('Recording…');
  }

  function startStats() {
    stopStats();
    statsTimer = setInterval(async () => {
      if (!sendTransport && !recvTransport) return;
      const lines = [];
      try {
        if (sendTransport) {
          const st = await sendTransport.getStats();
          st.forEach((r) => {
            if (r.type === 'outbound-rtp' && !r.isRemote) {
              lines.push(
                `↑ ${r.kind}: ${Math.round((r.bytesSent || 0) / 1024)} KB`
              );
            }
          });
        }
        if (recvTransport) {
          const st = await recvTransport.getStats();
          st.forEach((r) => {
            if (r.type === 'inbound-rtp' && !r.isRemote) {
              lines.push(
                `↓ ${r.kind}: ${Math.round((r.bytesReceived || 0) / 1024)} KB, lost ${r.packetsLost || 0}`
              );
            }
          });
        }
      } catch (_) {}
      statsContent.innerHTML = lines.length
        ? lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('')
        : '<p class="muted">Collecting…</p>';
    }, 2000);
  }

  function stopStats() {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
    }, 25000);
  }

  function stopPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  async function loadDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const fill = (sel, kind) => {
        sel.innerHTML = '';
        devices
          .filter((d) => d.kind === kind)
          .forEach((d) => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `${kind} ${sel.options.length + 1}`;
            sel.appendChild(opt);
          });
      };
      fill(selectCamera, 'videoinput');
      fill(selectMic, 'audioinput');
      fill(selectSpeaker, 'audiooutput');
    } catch (e) {
      console.warn(e);
    }
  }

  async function applySettings() {
    const newName = settingsName.value.trim().slice(0, 32);
    if (newName && newName !== displayName && peerId) {
      displayName = newName;
      localName.textContent = displayName;
      await request('updateDisplayName', { displayName }).catch(() => {});
      updateParticipants();
    }
    localVideo.classList.toggle('mirror', mirrorLocal.checked);
    const sfu = settingsSfuUrl.value.trim();
    if (sfu) localStorage.setItem('sfuUrl', sfu.replace(/\/ws$/, ''));
    settingsModal.classList.add('hidden');
    toast('Settings applied');
  }

  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    joinRoom(displayNameInput.value.trim() || 'Guest', roomIdInput.value.trim());
  });

  $('#leave-btn')?.addEventListener('click', () => leaveRoom());
  $('#toggle-mic')?.addEventListener('click', () => toggleMic());
  $('#toggle-cam')?.addEventListener('click', () => toggleCam());
  $('#toggle-screen')?.addEventListener('click', () => toggleScreen());
  $('#toggle-noise')?.addEventListener('click', () => toggleNoise());
  $('#toggle-record')?.addEventListener('click', () => toggleRecord());
  $('#toggle-reactions')?.addEventListener('click', () => reactionsBar.classList.toggle('hidden'));
  $('#toggle-participants')?.addEventListener('click', () => {
    $('#participants-panel').classList.toggle('hidden');
    $('#chat-panel').classList.add('hidden');
    $('#stats-panel').classList.add('hidden');
  });
  $('#toggle-chat')?.addEventListener('click', () => {
    $('#chat-panel').classList.toggle('hidden');
    $('#participants-panel').classList.add('hidden');
    $('#stats-panel').classList.add('hidden');
  });
  $('#toggle-stats')?.addEventListener('click', () => {
    $('#stats-panel').classList.toggle('hidden');
    $('#participants-panel').classList.add('hidden');
    $('#chat-panel').classList.add('hidden');
  });
  $('#toggle-settings')?.addEventListener('click', () => {
    settingsName.value = displayName;
    settingsSfuUrl.value = localStorage.getItem('sfuUrl') || defaultSfuUrl().replace(/\/ws$/, '');
    loadDevices();
    settingsModal.classList.remove('hidden');
  });
  $('#close-settings')?.addEventListener('click', () => settingsModal.classList.add('hidden'));
  $('#apply-settings')?.addEventListener('click', () => applySettings());

  $$('.close-panel').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.panel;
      if (id) $('#' + id)?.classList.add('hidden');
    });
  });

  reactionsBar?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-emoji]');
    if (!btn) return;
    const emoji = btn.dataset.emoji;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'reaction', emoji }));
    showFloatingReaction(emoji);
  });

  chatForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    request('chat', { text }).catch(() => toast('Chat failed'));
    chatInput.value = '';
  });

  $('#copy-room')?.addEventListener('click', () => {
    navigator.clipboard.writeText(roomId || '').then(() => toast('Room ID copied'));
  });
  $('#copy-invite')?.addEventListener('click', () => {
    const u = new URL(location.href);
    u.searchParams.set('room', roomId || '');
    const sfu = localStorage.getItem('sfuUrl');
    if (sfu) u.searchParams.set('sfu', sfu.includes('/ws') ? sfu : sfu + '/ws');
    navigator.clipboard.writeText(u.toString()).then(() => toast('Invite link copied'));
  });

  const qRoom = qs('room');
  const qName = qs('name');
  if (qRoom) roomIdInput.value = qRoom;
  if (qName) displayNameInput.value = qName;
  displayNameInput.value = displayNameInput.value || localStorage.getItem('displayName') || '';
  displayNameInput.addEventListener('change', () => {
    localStorage.setItem('displayName', displayNameInput.value.trim());
  });

  $('#toggle-noise')?.classList.add('active');
  console.log('[WebRTC Room] client ready');
})();
