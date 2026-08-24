/**
 * WebRTC Room — mediasoup client
 * Audio / video / screen / chat / reactions / stats / devices
 */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  // ── State ────────────────────────────────────────────────────
  const state = {
    ws: null,
    device: null,
    sendTransport: null,
    recvTransport: null,
    peerId: null,
    roomId: null,
    name: 'You',
    producers: new Map(), // kind|source -> producer
    consumers: new Map(), // consumerId -> { consumer, peerId, kind, appData }
    peers: new Map(),     // peerId -> { id, name, tiles: Map }
    localStream: null,
    screenStream: null,
    micEnabled: true,
    camEnabled: true,
    screenEnabled: false,
    noiseSuppression: true,
    mirror: true,
    recording: false,
    mediaRecorder: null,
    recordedChunks: [],
    sfuUrl: null,
    statsTimer: null,
    pending: new Map(), // requestId -> { resolve, reject }
    reqSeq: 0,
  };

  // ── DOM ──────────────────────────────────────────────────────
  const lobby = $('#lobby');
  const call = $('#call');
  const joinForm = $('#join-form');
  const displayNameInput = $('#display-name');
  const roomIdInput = $('#room-id');
  const currentRoomEl = $('#current-room');
  const peerCountEl = $('#peer-count');
  const videosGrid = $('#videos-grid');
  const localVideo = $('#local-video');
  const localNameEl = $('#local-name');
  const localMutedBadge = $('#local-muted');
  const localMeterBar = $('#local-meter .meter-bar');
  const chatMessages = $('#chat-messages');
  const chatForm = $('#chat-form');
  const chatInput = $('#chat-input');
  const participantsList = $('#participants-list');
  const statsContent = $('#stats-content');
  const reactionsBar = $('#reactions-bar');
  const floatingReactions = $('#floating-reactions');
  const toasts = $('#toasts');
  const recordingIndicator = $('#recording-indicator');
  const settingsModal = $('#settings-modal');

  // Restore name
  try {
    const saved = localStorage.getItem('webrtc-room-name');
    if (saved) displayNameInput.value = saved;
  } catch (_) {}

  // URL params
  const params = new URLSearchParams(location.search);
  if (params.get('room')) roomIdInput.value = params.get('room');
  if (params.get('sfu')) state.sfuUrl = params.get('sfu');
  if (params.get('name')) displayNameInput.value = params.get('name');

  // ── Helpers ──────────────────────────────────────────────────
  function toast(msg, ms = 2800) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    toasts.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function request(type, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!state.ws || state.ws.readyState !== 1) {
        reject(new Error('not connected'));
        return;
      }
      const requestId = `r${++state.reqSeq}`;
      state.pending.set(requestId, { resolve, reject });
      state.ws.send(JSON.stringify({ type, requestId, ...payload }));
      setTimeout(() => {
        if (state.pending.has(requestId)) {
          state.pending.delete(requestId);
          reject(new Error(`timeout: ${type}`));
        }
      }, 15000);
    });
  }

  function resolvePending(msg) {
    const { requestId } = msg;
    if (!requestId || !state.pending.has(requestId)) return false;
    const { resolve, reject } = state.pending.get(requestId);
    state.pending.delete(requestId);
    if (msg.type === 'error') reject(new Error(msg.message || 'error'));
    else resolve(msg);
    return true;
  }

  function wsUrl() {
    if (state.sfuUrl) {
      // allow wss://host or wss://host/ws
      const u = state.sfuUrl.replace(/\/$/, '');
      return u.endsWith('/ws') ? u : `${u}/ws`;
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  // ── WebSocket ────────────────────────────────────────────────
  function connectWs() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl());
      state.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('WebSocket connection failed'));
      ws.onclose = () => {
        if (call && !call.classList.contains('hidden')) {
          toast('Disconnected from server');
        }
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (resolvePending(msg)) return;
        handleServerEvent(msg);
      };
    });
  }

  function handleServerEvent(msg) {
    switch (msg.type) {
      case 'peer-joined':
        ensurePeer(msg.peer.id, msg.peer.name);
        updateParticipants();
        updatePeerCount();
        toast(`${msg.peer.name} joined`);
        break;
      case 'peer-left':
        removePeer(msg.peerId);
        updateParticipants();
        updatePeerCount();
        break;
      case 'peer-renamed': {
        const p = state.peers.get(msg.peerId);
        if (p) {
          p.name = msg.name;
          const label = document.querySelector(`[data-peer="${msg.peerId}"] .tile-label span`);
          if (label) label.textContent = msg.name;
          updateParticipants();
        }
        break;
      }
      case 'new-producer':
        consumeProducer(msg.peerId, msg.producerId, msg.kind, msg.appData);
        break;
      case 'producer-closed':
        closeRemoteProducer(msg.peerId, msg.producerId);
        break;
      case 'consumer-closed': {
        const entry = state.consumers.get(msg.consumerId);
        if (entry) {
          try { entry.consumer.close(); } catch (_) {}
          state.consumers.delete(msg.consumerId);
          removeTileTrack(entry.peerId, entry.appData?.source || entry.kind);
        }
        break;
      }
      case 'chat':
        appendChat(msg.name, msg.text, msg.peerId === state.peerId);
        break;
      case 'reaction':
        showFloatingReaction(msg.emoji, msg.name);
        break;
      case 'error':
        toast(msg.message || 'Server error');
        break;
      default:
        break;
    }
  }

  // ── Join flow ────────────────────────────────────────────────
  joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = displayNameInput.value.trim() || 'Guest';
    const roomId = roomIdInput.value.trim();
    try {
      localStorage.setItem('webrtc-room-name', name);
    } catch (_) {}

    const btn = $('#join-btn');
    btn.disabled = true;
    btn.textContent = 'Connecting…';

    try {
      await startCall(name, roomId);
    } catch (err) {
      console.error(err);
      toast(err.message || 'Failed to join');
      btn.disabled = false;
      btn.textContent = 'Join Room';
    }
  });

  async function startCall(name, roomId) {
    // Media first (permissions)
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: state.noiseSuppression,
        autoGainControl: true,
      },
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
    });

    localVideo.srcObject = state.localStream;
    localVideo.classList.toggle('mirror', state.mirror);
    localNameEl.textContent = name;
    state.name = name;
    startLocalMeter();

    await connectWs();

    const joined = await request('join', { name, roomId: roomId || undefined });
    state.peerId = joined.peerId;
    state.roomId = joined.roomId;
    state.name = joined.name;

    // mediasoup device
    const device = new mediasoupClient.Device();
    await device.load({ routerRtpCapabilities: joined.rtpCapabilities });
    state.device = device;

    // Transports
    await createSendTransport();
    await createRecvTransport();

    // Produce local tracks
    const audioTrack = state.localStream.getAudioTracks()[0];
    const videoTrack = state.localStream.getVideoTracks()[0];
    if (audioTrack) await produceTrack(audioTrack, 'audio', { source: 'mic' });
    if (videoTrack) await produceTrack(videoTrack, 'video', { source: 'camera' });

    // Existing peers + their producers
    for (const p of joined.peers || []) {
      ensurePeer(p.id, p.name);
      for (const prod of p.producers || []) {
        await consumeProducer(p.id, prod.id, prod.kind, prod.appData);
      }
    }

    // UI
    currentRoomEl.textContent = state.roomId;
    lobby.classList.add('hidden');
    call.classList.remove('hidden');
    updateParticipants();
    updatePeerCount();
    loadDevices();
    startStatsPolling();

    // Update URL without reload
    const url = new URL(location.href);
    url.searchParams.set('room', state.roomId);
    history.replaceState(null, '', url);
  }

  async function createSendTransport() {
    const info = await request('createWebRtcTransport', { direction: 'send' });
    const transport = state.device.createSendTransport({
      id: info.id,
      iceParameters: info.iceParameters,
      iceCandidates: info.iceCandidates,
      dtlsParameters: info.dtlsParameters,
    });

    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      request('connectWebRtcTransport', {
        transportId: transport.id,
        dtlsParameters,
      })
        .then(() => callback())
        .catch(errback);
    });

    transport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
      try {
        const res = await request('produce', { kind, rtpParameters, appData });
        callback({ id: res.id });
      } catch (err) {
        errback(err);
      }
    });

    state.sendTransport = transport;
  }

  async function createRecvTransport() {
    const info = await request('createWebRtcTransport', { direction: 'recv' });
    const transport = state.device.createRecvTransport({
      id: info.id,
      iceParameters: info.iceParameters,
      iceCandidates: info.iceCandidates,
      dtlsParameters: info.dtlsParameters,
    });

    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      request('connectWebRtcTransport', {
        transportId: transport.id,
        dtlsParameters,
      })
        .then(() => callback())
        .catch(errback);
    });

    state.recvTransport = transport;
  }

  async function produceTrack(track, kind, appData) {
    if (!state.sendTransport) return null;
    const producer = await state.sendTransport.produce({ track, appData });
    const key = `${kind}:${appData.source || 'default'}`;
    state.producers.set(key, producer);
    producer.on('transportclose', () => state.producers.delete(key));
    return producer;
  }

  async function consumeProducer(peerId, producerId, kind, appData) {
    if (!state.device || !state.recvTransport) return;
    if (!state.device.canConsume || !state.device.rtpCapabilities) return;

    try {
      const res = await request('consume', {
        producerId,
        rtpCapabilities: state.device.rtpCapabilities,
      });

      const consumer = await state.recvTransport.consume({
        id: res.id,
        producerId: res.producerId,
        kind: res.kind,
        rtpParameters: res.rtpParameters,
        appData: res.appData || appData || {},
      });

      state.consumers.set(consumer.id, {
        consumer,
        peerId,
        kind: res.kind,
        appData: res.appData || appData || {},
      });

      await request('resumeConsumer', { consumerId: consumer.id });

      ensurePeer(peerId);
      attachRemoteTrack(peerId, consumer.track, res.appData || appData || {}, res.kind);
    } catch (err) {
      console.error('consume failed', err);
    }
  }

  // ── Video tiles ──────────────────────────────────────────────
  function ensurePeer(id, name) {
    if (!state.peers.has(id)) {
      state.peers.set(id, { id, name: name || 'Peer', tiles: new Map() });
    } else if (name) {
      state.peers.get(id).name = name;
    }
    return state.peers.get(id);
  }

  function attachRemoteTrack(peerId, track, appData, kind) {
    const peer = ensurePeer(peerId);
    const source = appData.source || kind;
    const tileId = `tile-${peerId}-${source}`;

    let tile = document.getElementById(tileId);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'video-tile';
      tile.id = tileId;
      tile.dataset.peer = peerId;
      tile.innerHTML = `
        <video autoplay playsinline></video>
        <div class="tile-overlay">
          <div class="tile-label">
            <span>${escapeHtml(peer.name)}</span>
            <span class="badges"></span>
          </div>
        </div>`;
      videosGrid.appendChild(tile);
    }

    const video = tile.querySelector('video');
    let stream = video.srcObject;
    if (!(stream instanceof MediaStream)) {
      stream = new MediaStream();
      video.srcObject = stream;
    }

    // Replace same-kind track if present
    for (const t of stream.getTracks()) {
      if (t.kind === track.kind) {
        stream.removeTrack(t);
        t.stop();
      }
    }
    stream.addTrack(track);
    peer.tiles.set(source, tileId);
  }

  function removeTileTrack(peerId, source) {
    const tileId = `tile-${peerId}-${source}`;
    const tile = document.getElementById(tileId);
    if (tile) {
      const video = tile.querySelector('video');
      if (video?.srcObject) {
        video.srcObject.getTracks().forEach((t) => t.stop());
      }
      tile.remove();
    }
    const peer = state.peers.get(peerId);
    if (peer) peer.tiles.delete(source);
  }

  function removePeer(peerId) {
    const peer = state.peers.get(peerId);
    if (!peer) return;
    for (const tileId of peer.tiles.values()) {
      const tile = document.getElementById(tileId);
      if (tile) {
        const video = tile.querySelector('video');
        if (video?.srcObject) video.srcObject.getTracks().forEach((t) => t.stop());
        tile.remove();
      }
    }
    // Close consumers for this peer
    for (const [cid, entry] of state.consumers) {
      if (entry.peerId === peerId) {
        try { entry.consumer.close(); } catch (_) {}
        state.consumers.delete(cid);
      }
    }
    state.peers.delete(peerId);
  }

  function closeRemoteProducer(peerId, producerId) {
    for (const [cid, entry] of state.consumers) {
      if (entry.consumer.producerId === producerId) {
        try { entry.consumer.close(); } catch (_) {}
        state.consumers.delete(cid);
        removeTileTrack(peerId, entry.appData?.source || entry.kind);
      }
    }
  }

  // ── Controls ─────────────────────────────────────────────────
  $('#toggle-mic').addEventListener('click', () => {
    state.micEnabled = !state.micEnabled;
    const track = state.localStream?.getAudioTracks()[0];
    if (track) track.enabled = state.micEnabled;
    const prod = state.producers.get('audio:mic');
    if (prod) {
      if (state.micEnabled) prod.resume();
      else prod.pause();
    }
    $('#toggle-mic').classList.toggle('danger-active', !state.micEnabled);
    localMutedBadge.classList.toggle('hidden', state.micEnabled);
  });

  $('#toggle-cam').addEventListener('click', () => {
    state.camEnabled = !state.camEnabled;
    const track = state.localStream?.getVideoTracks()[0];
    if (track) track.enabled = state.camEnabled;
    const prod = state.producers.get('video:camera');
    if (prod) {
      if (state.camEnabled) prod.resume();
      else prod.pause();
    }
    $('#toggle-cam').classList.toggle('danger-active', !state.camEnabled);
  });

  $('#toggle-screen').addEventListener('click', async () => {
    if (!state.screenEnabled) {
      try {
        state.screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 15 },
          audio: false,
        });
        const track = state.screenStream.getVideoTracks()[0];
        track.onended = () => stopScreen();
        await produceTrack(track, 'video', { source: 'screen' });
        state.screenEnabled = true;
        $('#toggle-screen').classList.add('active');
        toast('Screen sharing');
      } catch (err) {
        if (err.name !== 'NotAllowedError') toast('Screen share failed');
      }
    } else {
      stopScreen();
    }
  });

  async function stopScreen() {
    const prod = state.producers.get('video:screen');
    if (prod) {
      try {
        await request('closeProducer', { producerId: prod.id });
      } catch (_) {}
      try { prod.close(); } catch (_) {}
      state.producers.delete('video:screen');
    }
    state.screenStream?.getTracks().forEach((t) => t.stop());
    state.screenStream = null;
    state.screenEnabled = false;
    $('#toggle-screen').classList.remove('active');
  }

  $('#toggle-noise').addEventListener('click', async () => {
    state.noiseSuppression = !state.noiseSuppression;
    $('#toggle-noise').classList.toggle('active', state.noiseSuppression);
    // Re-acquire audio track with new constraint
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: state.noiseSuppression,
          autoGainControl: true,
        },
      });
      const newTrack = newStream.getAudioTracks()[0];
      const oldTrack = state.localStream.getAudioTracks()[0];
      state.localStream.removeTrack(oldTrack);
      oldTrack.stop();
      state.localStream.addTrack(newTrack);
      const prod = state.producers.get('audio:mic');
      if (prod) await prod.replaceTrack({ track: newTrack });
      toast(state.noiseSuppression ? 'Noise suppression on' : 'Noise suppression off');
    } catch (err) {
      toast('Could not update mic');
    }
  });
  // default active
  $('#toggle-noise').classList.add('active');

  $('#toggle-record').addEventListener('click', () => {
    if (!state.recording) startRecording();
    else stopRecording();
  });

  function startRecording() {
    const tracks = [];
    if (state.localStream) tracks.push(...state.localStream.getTracks());
    // Optionally mix remote — keep simple: local only for reliability
    if (!tracks.length) {
      toast('Nothing to record');
      return;
    }
    const stream = new MediaStream(tracks.map((t) => t.clone()));
    state.recordedChunks = [];
    try {
      state.mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
          ? 'video/webm;codecs=vp9,opus'
          : 'video/webm',
      });
    } catch {
      state.mediaRecorder = new MediaRecorder(stream);
    }
    state.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size) state.recordedChunks.push(e.data);
    };
    state.mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(state.recordedChunks, { type: 'video/webm' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `room-${state.roomId}-${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Recording saved');
    };
    state.mediaRecorder.start(1000);
    state.recording = true;
    $('#toggle-record').classList.add('danger-active');
    recordingIndicator.classList.remove('hidden');
  }

  function stopRecording() {
    if (state.mediaRecorder && state.recording) {
      state.mediaRecorder.stop();
    }
    state.recording = false;
    $('#toggle-record').classList.remove('danger-active');
    recordingIndicator.classList.add('hidden');
  }

  $('#toggle-reactions').addEventListener('click', () => {
    reactionsBar.classList.toggle('hidden');
    $('#toggle-reactions').classList.toggle('active');
  });

  reactionsBar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-emoji]');
    if (!btn) return;
    const emoji = btn.dataset.emoji;
    state.ws?.send(JSON.stringify({ type: 'reaction', emoji }));
    showFloatingReaction(emoji, 'You');
  });

  function showFloatingReaction(emoji, name) {
    const el = document.createElement('div');
    el.style.cssText =
      'position:absolute;bottom:120px;left:50%;font-size:2rem;animation:floatUp 2s ease-out forwards;pointer-events:none;';
    el.textContent = emoji;
    el.title = name;
    floatingReactions.appendChild(el);
    setTimeout(() => el.remove(), 2000);
  }

  // inject keyframes once
  const styleAnim = document.createElement('style');
  styleAnim.textContent =
    '@keyframes floatUp{0%{opacity:1;transform:translate(-50%,0) scale(1)}100%{opacity:0;transform:translate(-50%,-80px) scale(1.4)}}';
  document.head.appendChild(styleAnim);

  function togglePanel(id) {
    const panel = document.getElementById(id);
    const wasHidden = panel.classList.contains('hidden');
    $$('.side-panel').forEach((p) => p.classList.add('hidden'));
    if (wasHidden) panel.classList.remove('hidden');
  }

  $('#toggle-participants').addEventListener('click', () => togglePanel('participants-panel'));
  $('#toggle-chat').addEventListener('click', () => togglePanel('chat-panel'));
  $('#toggle-stats').addEventListener('click', () => togglePanel('stats-panel'));
  $$('.close-panel').forEach((btn) =>
    btn.addEventListener('click', () => {
      document.getElementById(btn.dataset.panel)?.classList.add('hidden');
    })
  );

  $('#toggle-settings').addEventListener('click', () => {
    $('#settings-name').value = state.name;
    $('#settings-sfu-url').value = state.sfuUrl || '';
    $('#mirror-local').checked = state.mirror;
    settingsModal.classList.remove('hidden');
  });
  $('#close-settings').addEventListener('click', () => settingsModal.classList.add('hidden'));
  $('#apply-settings').addEventListener('click', async () => {
    const newName = $('#settings-name').value.trim().slice(0, 32);
    if (newName && newName !== state.name) {
      try {
        await request('rename', { name: newName });
        state.name = newName;
        localNameEl.textContent = newName;
        try { localStorage.setItem('webrtc-room-name', newName); } catch (_) {}
      } catch (_) {}
    }
    state.mirror = $('#mirror-local').checked;
    localVideo.classList.toggle('mirror', state.mirror);
    const sfu = $('#settings-sfu-url').value.trim();
    if (sfu) state.sfuUrl = sfu;
    settingsModal.classList.add('hidden');
    toast('Settings applied');
  });

  // Chat
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    state.ws?.send(JSON.stringify({ type: 'chat', text }));
    chatInput.value = '';
  });

  function appendChat(name, text, self) {
    const row = document.createElement('div');
    row.style.cssText = 'margin-bottom:0.6rem;font-size:0.9rem;';
    row.innerHTML = `<strong style="color:${self ? 'var(--primary)' : 'var(--text)'}">${escapeHtml(name)}</strong>
      <span style="color:var(--text-muted);margin-left:0.35rem">${escapeHtml(text)}</span>`;
    chatMessages.appendChild(row);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function updateParticipants() {
    participantsList.innerHTML = '';
    // local
    const liYou = document.createElement('li');
    liYou.style.cssText = 'padding:0.5rem 1rem;border-bottom:1px solid var(--border)';
    liYou.textContent = `${state.name} (you)`;
    participantsList.appendChild(liYou);
    for (const p of state.peers.values()) {
      const li = document.createElement('li');
      li.style.cssText = 'padding:0.5rem 1rem;border-bottom:1px solid var(--border)';
      li.textContent = p.name;
      participantsList.appendChild(li);
    }
  }

  function updatePeerCount() {
    peerCountEl.textContent = String(1 + state.peers.size);
  }

  // Copy room / invite
  $('#copy-room').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.roomId);
      toast('Room ID copied');
    } catch {
      toast(state.roomId);
    }
  });
  $('#copy-invite').addEventListener('click', async () => {
    const url = new URL(location.href);
    url.searchParams.set('room', state.roomId);
    if (state.sfuUrl) url.searchParams.set('sfu', state.sfuUrl);
    try {
      await navigator.clipboard.writeText(url.toString());
      toast('Invite link copied');
    } catch {
      toast(url.toString());
    }
  });

  // Leave
  $('#leave-btn').addEventListener('click', () => leaveCall());

  function leaveCall() {
    stopRecording();
    stopScreen();
    if (state.statsTimer) clearInterval(state.statsTimer);
    for (const p of state.producers.values()) {
      try { p.close(); } catch (_) {}
    }
    state.producers.clear();
    for (const c of state.consumers.values()) {
      try { c.consumer.close(); } catch (_) {}
    }
    state.consumers.clear();
    try { state.sendTransport?.close(); } catch (_) {}
    try { state.recvTransport?.close(); } catch (_) {}
    try { state.ws?.close(); } catch (_) {}
    state.localStream?.getTracks().forEach((t) => t.stop());
    state.localStream = null;
    // Clear remote tiles
    for (const id of [...state.peers.keys()]) removePeer(id);
    call.classList.add('hidden');
    lobby.classList.remove('hidden');
    $('#join-btn').disabled = false;
    $('#join-btn').textContent = 'Join Room';
  }

  // ── Devices ──────────────────────────────────────────────────
  async function loadDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const camSel = $('#select-camera');
      const micSel = $('#select-mic');
      const spkSel = $('#select-speaker');
      camSel.innerHTML = '';
      micSel.innerHTML = '';
      spkSel.innerHTML = '';
      for (const d of devices) {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `${d.kind} ${d.deviceId.slice(0, 6)}`;
        if (d.kind === 'videoinput') camSel.appendChild(opt);
        if (d.kind === 'audioinput') micSel.appendChild(opt);
        if (d.kind === 'audiooutput') spkSel.appendChild(opt);
      }
    } catch (_) {}
  }

  $('#select-camera').addEventListener('change', async (e) => {
    const deviceId = e.target.value;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId } },
      });
      const newTrack = stream.getVideoTracks()[0];
      const old = state.localStream.getVideoTracks()[0];
      state.localStream.removeTrack(old);
      old.stop();
      state.localStream.addTrack(newTrack);
      localVideo.srcObject = state.localStream;
      const prod = state.producers.get('video:camera');
      if (prod) await prod.replaceTrack({ track: newTrack });
    } catch {
      toast('Camera switch failed');
    }
  });

  $('#select-mic').addEventListener('change', async (e) => {
    const deviceId = e.target.value;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          echoCancellation: true,
          noiseSuppression: state.noiseSuppression,
        },
      });
      const newTrack = stream.getAudioTracks()[0];
      const old = state.localStream.getAudioTracks()[0];
      state.localStream.removeTrack(old);
      old.stop();
      state.localStream.addTrack(newTrack);
      const prod = state.producers.get('audio:mic');
      if (prod) await prod.replaceTrack({ track: newTrack });
    } catch {
      toast('Mic switch failed');
    }
  });

  $('#select-speaker').addEventListener('change', async (e) => {
    const deviceId = e.target.value;
    $$('.video-tile video').forEach(async (v) => {
      if (typeof v.setSinkId === 'function') {
        try {
          await v.setSinkId(deviceId);
        } catch (_) {}
      }
    });
  });

  // ── Audio meter ──────────────────────────────────────────────
  let audioCtx, analyser, meterData;
  function startLocalMeter() {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(state.localStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      meterData = new Uint8Array(analyser.frequencyBinCount);
      const loop = () => {
        if (!analyser) return;
        analyser.getByteFrequencyData(meterData);
        let sum = 0;
        for (let i = 0; i < meterData.length; i++) sum += meterData[i];
        const avg = sum / meterData.length;
        const pct = Math.min(100, (avg / 80) * 100);
        if (localMeterBar) localMeterBar.style.height = `${pct}%`;
        requestAnimationFrame(loop);
      };
      loop();
    } catch (_) {}
  }

  // ── Stats ────────────────────────────────────────────────────
  function startStatsPolling() {
    if (state.statsTimer) clearInterval(state.statsTimer);
    state.statsTimer = setInterval(async () => {
      const lines = [];
      try {
        if (state.sendTransport) {
          const stats = await state.sendTransport.getStats();
          stats.forEach((r) => {
            if (r.type === 'outbound-rtp' && r.kind === 'video') {
              lines.push(`Out video: ${(r.bytesSent / 1024).toFixed(0)} KB, ${r.framesPerSecond || '?'} fps`);
            }
            if (r.type === 'outbound-rtp' && r.kind === 'audio') {
              lines.push(`Out audio: ${(r.bytesSent / 1024).toFixed(0)} KB`);
            }
          });
        }
        if (state.recvTransport) {
          const stats = await state.recvTransport.getStats();
          stats.forEach((r) => {
            if (r.type === 'inbound-rtp' && r.kind === 'video') {
              lines.push(`In video: ${(r.bytesReceived / 1024).toFixed(0)} KB, lost ${r.packetsLost || 0}`);
            }
          });
        }
      } catch (_) {}
      lines.push(`Peers: ${1 + state.peers.size}`);
      lines.push(`Producers: ${state.producers.size}`);
      lines.push(`Consumers: ${state.consumers.size}`);
      statsContent.innerHTML = lines.map((l) => `<p style="margin:0.35rem 0;font-size:0.85rem">${escapeHtml(l)}</p>`).join('') || '<p class="muted">No stats yet</p>';
    }, 2000);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Prevent accidental leave
  window.addEventListener('beforeunload', (e) => {
    if (state.peerId) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
})();
