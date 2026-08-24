/**
 * WebRTC Room client (mediasoup-client)
 * Fixed: XSS escape, transport construction, audio-only peers, guards, cleanup
 */
(() => {
  'use strict';

  const ms = window.mediasoupClient;
  if (!ms || !ms.Device) {
    document.body.innerHTML =
      '<p style="color:#fff;padding:2rem;font-family:system-ui">Failed to load mediasoup-client CDN.</p>';
    return;
  }
  const { Device } = ms;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  const lobby = $('#lobby');
  const call = $('#call');
  const joinForm = $('#join-form');
  const displayNameInput = $('#display-name');
  const roomIdInput = $('#room-id');
  const roomPinInput = $('#room-pin');
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
  let joining = false;

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

  // Safe HTML escape via DOM (no entity literals that get corrupted in tooling)
  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function defaultSfuUrl() {
    const fromQuery = qs('sfu');
    if (fromQuery) return fromQuery;
    const stored = localStorage.getItem('sfuUrl');
    if (stored) return stored.includes('/ws') ? stored : stored.replace(/\/?$/, '') + '/ws';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  }

  function request(type, payload, timeoutMs) {
    payload = payload || {};
    timeoutMs = timeoutMs || 15000;
    return new Promise(function (resolve, reject) {
      if (!ws || ws.readyState !== 1) {
        reject(new Error('Not connected'));
        return;
      }
      var requestId = 'r' + ++requestSeq;
      var timer = setTimeout(function () {
        pending.delete(requestId);
        reject(new Error('Timeout: ' + type));
      }, timeoutMs);
      pending.set(requestId, { resolve: resolve, reject: reject, timer: timer });
      var body = Object.assign({ type: type, requestId: requestId }, payload);
      ws.send(JSON.stringify(body));
    });
  }

  function handleServerMessage(msg) {
    if (msg.requestId && pending.has(msg.requestId)) {
      var p = pending.get(msg.requestId);
      pending.delete(msg.requestId);
      clearTimeout(p.timer);
      if (msg.type === 'error') p.reject(new Error(msg.error || 'error'));
      else p.resolve(msg);
      return;
    }
    switch (msg.type) {
      case 'peerJoined':
        ensurePeer(msg.peer.id, msg.peer.displayName);
        updatePeerCount();
        updateParticipants();
        toast(msg.peer.displayName + ' joined');
        break;
      case 'peerLeft':
        removePeer(msg.peerId);
        updatePeerCount();
        updateParticipants();
        toast((msg.displayName || 'Someone') + ' left');
        break;
      case 'peerUpdated':
        if (peers.has(msg.peerId)) {
          peers.get(msg.peerId).displayName = msg.displayName;
          updatePeerLabels(msg.peerId);
          updateParticipants();
        }
        break;
      case 'newProducer':
        consumeProducer(msg.producerId, msg.peerId, msg.displayName, msg.kind, msg.appData || {});
        break;
      case 'producerClosed':
        closeConsumerForProducer(msg.producerId);
        break;
      case 'consumerClosed':
        closeConsumer(msg.consumerId);
        break;
      case 'chat':
        appendChat(msg.displayName, msg.text);
        break;
      case 'reaction':
        showFloatingReaction(msg.emoji);
        break;
      default:
        break;
    }
  }

  function connectWs(url) {
    return new Promise(function (resolve, reject) {
      var socket = new WebSocket(url);
      var t = setTimeout(function () {
        socket.close();
        reject(new Error('WebSocket connect timeout'));
      }, 10000);
      socket.onopen = function () {
        clearTimeout(t);
        ws = socket;
        resolve();
      };
      socket.onerror = function () {
        clearTimeout(t);
        reject(new Error('WebSocket error — is the SFU running?'));
      };
      socket.onmessage = function (ev) {
        try {
          handleServerMessage(JSON.parse(ev.data));
        } catch (e) {
          console.warn('bad message', e);
        }
      };
      socket.onclose = function () {
        ws = null;
        if (!joining && call && !call.classList.contains('hidden')) {
          toast('Disconnected from SFU');
          leaveRoom(true);
        }
      };
    });
  }

  async function getLocalMedia() {
    var audio = {
      echoCancellation: true,
      noiseSuppression: noiseSuppression,
      autoGainControl: true,
    };
    var video = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    };
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: audio, video: video });
    } catch (e) {
      console.warn('Cam failed, audio only', e);
      localStream = await navigator.mediaDevices.getUserMedia({ audio: audio });
      camEnabled = false;
    }
    localVideo.srcObject = localStream;
    localVideo.classList.toggle('mirror', mirrorLocal.checked);
    applyMicCamState();
    startLocalMeter();
  }

  function applyMicCamState() {
    if (!localStream) return;
    localStream.getAudioTracks().forEach(function (t) {
      t.enabled = micEnabled;
    });
    localStream.getVideoTracks().forEach(function (t) {
      t.enabled = camEnabled;
    });
    localMuted.classList.toggle('hidden', micEnabled);
    var micBtn = $('#toggle-mic');
    var camBtn = $('#toggle-cam');
    if (micBtn) micBtn.classList.toggle('danger-active', !micEnabled);
    if (camBtn) camBtn.classList.toggle('danger-active', !camEnabled);
  }

  function startLocalMeter() {
    stopLocalMeter();
    var bar = document.querySelector('#local-meter .meter-bar');
    if (!bar || !localStream || !localStream.getAudioTracks().length) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      var ctx = new AC();
      var source = ctx.createMediaStreamSource(localStream);
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      var data = new Uint8Array(analyser.frequencyBinCount);
      meterTimer = setInterval(function () {
        if (!micEnabled) {
          bar.style.height = '0%';
          return;
        }
        analyser.getByteFrequencyData(data);
        var sum = 0;
        for (var i = 0; i < data.length; i++) sum += data[i];
        bar.style.height = Math.min(100, Math.round((sum / data.length / 255) * 140)) + '%';
      }, 80);
    } catch (e) {}
  }

  function stopLocalMeter() {
    if (meterTimer) clearInterval(meterTimer);
    meterTimer = null;
  }

  async function joinRoom(name, rid, pin) {
    joinBtn.disabled = true;
    joinBtn.textContent = 'Connecting…';
    joining = true;
    try {
      displayName = name;
      roomId = rid || genRoomId();

      var sfuUrl = (settingsSfuUrl.value || '').trim() || defaultSfuUrl();
      if (!sfuUrl) throw new Error('SFU URL required');
      if (sfuUrl.indexOf('/ws') === -1) sfuUrl = sfuUrl.replace(/\/?$/, '') + '/ws';
      localStorage.setItem('sfuUrl', sfuUrl.replace(/\/ws$/, ''));

      await connectWs(sfuUrl);

      var joinPayload = { roomId: roomId, displayName: name };
      if (pin) joinPayload.pin = pin;
      var joined = await request('join', joinPayload);

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

      (joined.peers || []).forEach(function (p) {
        ensurePeer(p.id, p.displayName);
      });
      var eps = joined.existingProducers || [];
      for (var i = 0; i < eps.length; i++) {
        var ep = eps[i];
        await consumeProducer(ep.producerId, ep.peerId, ep.displayName, ep.kind, ep.appData || {});
      }

      localName.textContent = displayName;
      currentRoomEl.textContent = roomId;
      lobby.classList.add('hidden');
      call.classList.remove('hidden');
      updatePeerCount();
      updateParticipants();
      startStats();
      startPing();

      var u = new URL(location.href);
      u.searchParams.set('room', roomId);
      history.replaceState(null, '', u);
      toast('Joined room ' + roomId + (joined.hasPin ? ' (PIN)' : ''));
    } catch (err) {
      console.error(err);
      var msg = err.message || 'Join failed';
      if (msg === 'invalid_pin') msg = 'Wrong room PIN';
      else if (msg === 'room_full') msg = 'Room is full';
      toast(msg);
      cleanupMedia();
      if (ws) {
        try {
          ws.close();
        } catch (e) {}
        ws = null;
      }
    } finally {
      joining = false;
      joinBtn.disabled = false;
      joinBtn.textContent = 'Join Room';
    }
  }

  async function createTransport(direction) {
    var info = await request('createWebRtcTransport', { direction: direction });
    // Only pass mediasoup-required fields (ignore type/requestId)
    var opts = {
      id: info.id,
      iceParameters: info.iceParameters,
      iceCandidates: info.iceCandidates,
      dtlsParameters: info.dtlsParameters,
    };
    var transport =
      direction === 'send' ? device.createSendTransport(opts) : device.createRecvTransport(opts);

    transport.on('connect', function (params, callback, errback) {
      request('connectWebRtcTransport', {
        transportId: transport.id,
        dtlsParameters: params.dtlsParameters,
      })
        .then(function () {
          callback();
        })
        .catch(errback);
    });

    if (direction === 'send') {
      transport.on('produce', function (params, callback, errback) {
        request('produce', {
          transportId: transport.id,
          kind: params.kind,
          rtpParameters: params.rtpParameters,
          appData: params.appData,
        })
          .then(function (res) {
            callback({ id: res.id });
          })
          .catch(errback);
      });
    }

    transport.on('connectionstatechange', function (state) {
      if (state === 'failed' || state === 'closed') {
        console.warn('Transport ' + direction + ':', state);
      }
    });
    return transport;
  }

  async function consumeProducer(producerId, remotePeerId, remoteName, kind, appData) {
    appData = appData || {};
    if (!device || !recvTransport) return;
    if (producerToConsumer.has(producerId)) return;
    ensurePeer(remotePeerId, remoteName);
    try {
      var consumed = await request('consume', {
        transportId: recvTransport.id,
        producerId: producerId,
        rtpCapabilities: device.rtpCapabilities,
      });
      var consumer = await recvTransport.consume({
        id: consumed.id,
        producerId: consumed.producerId,
        kind: consumed.kind,
        rtpParameters: consumed.rtpParameters,
      });
      consumers.set(consumer.id, consumer);
      producerToConsumer.set(producerId, consumer.id);
      var peer = peers.get(remotePeerId);
      if (peer) peer.consumers.set(consumer.id, consumer);

      var source = appData.source || kind;
      attachRemoteTrack(remotePeerId, remoteName, consumer.track, source, kind);
      await request('resumeConsumer', { consumerId: consumer.id });
      updateParticipants();
      applySpeaker();
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
        audioEl: null,
      });
    } else if (name) {
      peers.get(id).displayName = name;
    }
  }

  function attachRemoteTrack(remotePeerId, remoteName, track, source, kind) {
    var peer = peers.get(remotePeerId);
    if (!peer) return;

    // Audio-only (mic): play via <audio>, optional avatar tile without black video
    if (kind === 'audio' || source === 'mic') {
      if (!peer.audioEl) {
        peer.audioEl = document.createElement('audio');
        peer.audioEl.autoplay = true;
        peer.audioEl.playsInline = true;
        peer.audioEl.style.display = 'none';
        document.body.appendChild(peer.audioEl);
      }
      var aStream = peer.audioEl.srcObject;
      if (!aStream) {
        aStream = new MediaStream();
        peer.audioEl.srcObject = aStream;
      }
      aStream.getAudioTracks().forEach(function (t) {
        aStream.removeTrack(t);
      });
      aStream.addTrack(track);
      peer.audioEl.play().catch(function () {});

      // Ensure a visible tile for audio-only peers
      if (!peer.tiles.has('camera') && !peer.tiles.has('screen')) {
        ensureAvatarTile(remotePeerId, remoteName);
      }
      applySpeaker();
      return;
    }

    var tileKey = source === 'screen' ? 'screen' : 'camera';
    var tile = peer.tiles.get(tileKey);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'video-tile remote';
      tile.dataset.peerId = remotePeerId;
      tile.dataset.source = tileKey;
      tile.innerHTML =
        '<video autoplay playsinline></video>' +
        '<div class="tile-overlay"><div class="tile-label">' +
        '<span class="remote-name"></span>' +
        '<span class="source-badge">' +
        (tileKey === 'screen' ? '🖥️' : '') +
        '</span></div></div>';
      tile.querySelector('.remote-name').textContent = remoteName;
      videosGrid.appendChild(tile);
      peer.tiles.set(tileKey, tile);
      // Remove placeholder avatar if present
      if (peer.tiles.has('avatar')) {
        peer.tiles.get('avatar').remove();
        peer.tiles.delete('avatar');
      }
    }

    var video = tile.querySelector('video');
    var stream = video.srcObject;
    if (!stream) {
      stream = new MediaStream();
      video.srcObject = stream;
    }
    stream.getTracks().filter(function (t) {
      return t.kind === track.kind;
    }).forEach(function (t) {
      stream.removeTrack(t);
    });
    stream.addTrack(track);
    video.play().catch(function () {});
    applySpeaker();
  }

  function ensureAvatarTile(remotePeerId, remoteName) {
    var peer = peers.get(remotePeerId);
    if (!peer || peer.tiles.has('avatar') || peer.tiles.has('camera')) return;
    var tile = document.createElement('div');
    tile.className = 'video-tile remote';
    tile.dataset.peerId = remotePeerId;
    tile.dataset.source = 'avatar';
    var initial = (remoteName || '?').charAt(0).toUpperCase();
    tile.innerHTML =
      '<div class="avatar-placeholder" style="display:flex;align-items:center;justify-content:center;height:100%;background:#1a1d27;font-size:3rem;font-weight:600;color:#5b8def">' +
      escapeHtml(initial) +
      '</div>' +
      '<div class="tile-overlay"><div class="tile-label"><span class="remote-name"></span></div></div>';
    tile.querySelector('.remote-name').textContent = remoteName;
    videosGrid.appendChild(tile);
    peer.tiles.set('avatar', tile);
  }

  function applySpeaker() {
    var id = selectSpeaker && selectSpeaker.value;
    if (!id) return;
    $$('video, audio').forEach(function (el) {
      if (typeof el.setSinkId === 'function') {
        el.setSinkId(id).catch(function () {});
      }
    });
  }

  function updatePeerLabels(id) {
    var peer = peers.get(id);
    if (!peer) return;
    peer.tiles.forEach(function (tile) {
      var el = tile.querySelector('.remote-name');
      if (el) el.textContent = peer.displayName;
    });
  }

  function closeConsumerForProducer(producerId) {
    var cid = producerToConsumer.get(producerId);
    if (cid) closeConsumer(cid);
    producerToConsumer.delete(producerId);
  }

  function closeConsumer(consumerId) {
    var consumer = consumers.get(consumerId);
    if (!consumer) return;
    try {
      consumer.close();
    } catch (e) {}
    consumers.delete(consumerId);

    peers.forEach(function (peer) {
      peer.consumers.delete(consumerId);
      // Clean empty tiles
      peer.tiles.forEach(function (tile, source) {
        var video = tile.querySelector('video');
        var stream = video && video.srcObject;
        if (stream) {
          var live = stream.getTracks().filter(function (t) {
            return t.readyState === 'live';
          });
          if (live.length === 0) {
            tile.remove();
            peer.tiles.delete(source);
          }
        }
      });
    });
  }

  function removePeer(id) {
    var peer = peers.get(id);
    if (!peer) return;
    peer.tiles.forEach(function (tile) {
      tile.remove();
    });
    peer.consumers.forEach(function (c) {
      try {
        c.close();
      } catch (e) {}
      consumers.delete(c.id);
    });
    if (peer.audioEl) {
      try {
        peer.audioEl.pause();
        peer.audioEl.srcObject = null;
        peer.audioEl.remove();
      } catch (e) {}
    }
    peers.delete(id);
  }

  function cleanupMedia() {
    stopStats();
    stopPing();
    stopLocalMeter();
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try {
        mediaRecorder.stop();
      } catch (e) {}
    }
    mediaRecorder = null;
    recordedChunks = [];
    recordingIndicator.classList.add('hidden');

    [audioProducer, videoProducer, screenProducer].forEach(function (p) {
      try {
        if (p) p.close();
      } catch (e) {}
    });
    audioProducer = videoProducer = screenProducer = null;

    try {
      if (sendTransport) sendTransport.close();
    } catch (e) {}
    try {
      if (recvTransport) recvTransport.close();
    } catch (e) {}
    sendTransport = recvTransport = null;

    consumers.forEach(function (c) {
      try {
        c.close();
      } catch (e) {}
    });
    consumers.clear();
    producerToConsumer.clear();

    peers.forEach(function (peer) {
      peer.tiles.forEach(function (tile) {
        tile.remove();
      });
      if (peer.audioEl) {
        try {
          peer.audioEl.remove();
        } catch (e) {}
      }
    });
    peers.clear();

    if (localStream) {
      localStream.getTracks().forEach(function (t) {
        t.stop();
      });
      localStream = null;
    }
    if (screenStream) {
      screenStream.getTracks().forEach(function (t) {
        t.stop();
      });
      screenStream = null;
    }
    localVideo.srcObject = null;
    device = null;
  }

  function leaveRoom(fromClose) {
    if (!fromClose && ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: 'leave' }));
      } catch (e) {}
    }
    cleanupMedia();
    if (ws) {
      try {
        ws.close();
      } catch (e) {}
      ws = null;
    }
    peerId = null;
    call.classList.add('hidden');
    lobby.classList.remove('hidden');
    $$('.side-panel').forEach(function (p) {
      p.classList.add('hidden');
    });
    reactionsBar.classList.add('hidden');
    settingsModal.classList.add('hidden');
  }

  function updatePeerCount() {
    peerCountEl.textContent = String(peers.size + 1);
  }

  function updateParticipants() {
    participantsList.innerHTML = '';
    function add(name, isLocal) {
      var li = document.createElement('li');
      var span = document.createElement('span');
      span.textContent = name + (isLocal ? ' (you)' : '');
      li.appendChild(span);
      participantsList.appendChild(li);
    }
    add(displayName, true);
    peers.forEach(function (p) {
      add(p.displayName, false);
    });
  }

  function appendChat(name, text) {
    var div = document.createElement('div');
    div.className = 'chat-msg';
    var who = document.createElement('div');
    who.className = 'who';
    who.textContent = name;
    var body = document.createElement('div');
    body.className = 'body';
    body.textContent = text;
    div.appendChild(who);
    div.appendChild(body);
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function showFloatingReaction(emoji) {
    var el = document.createElement('div');
    el.textContent = emoji;
    el.style.cssText =
      'position:absolute;font-size:2rem;left:' +
      (20 + Math.random() * 60) +
      '%;bottom:20%;opacity:1;transition:all 2.2s ease-out;pointer-events:none;z-index:30;';
    floatingReactions.appendChild(el);
    requestAnimationFrame(function () {
      el.style.bottom = '70%';
      el.style.opacity = '0';
      el.style.transform = 'scale(1.4)';
    });
    setTimeout(function () {
      el.remove();
    }, 2300);
  }

  async function toggleMic() {
    micEnabled = !micEnabled;
    applyMicCamState();
    if (audioProducer) {
      try {
        if (micEnabled) {
          await audioProducer.resume();
          await request('resumeProducer', { producerId: audioProducer.id }).catch(function () {});
        } else {
          await audioProducer.pause();
          await request('pauseProducer', { producerId: audioProducer.id }).catch(function () {});
        }
      } catch (e) {
        console.warn(e);
      }
    }
  }

  async function toggleCam() {
    camEnabled = !camEnabled;
    applyMicCamState();
    if (videoProducer) {
      try {
        if (camEnabled) {
          await videoProducer.resume();
          await request('resumeProducer', { producerId: videoProducer.id }).catch(function () {});
        } else {
          await videoProducer.pause();
          await request('pauseProducer', { producerId: videoProducer.id }).catch(function () {});
        }
      } catch (e) {
        console.warn(e);
      }
    } else if (camEnabled && localStream && localStream.getVideoTracks().length && sendTransport) {
      videoProducer = await sendTransport.produce({
        track: localStream.getVideoTracks()[0],
        appData: { source: 'camera' },
      });
    }
  }

  async function toggleScreen() {
    var btn = $('#toggle-screen');
    if (screenProducer) {
      try {
        await request('closeProducer', { producerId: screenProducer.id });
      } catch (e) {}
      try {
        screenProducer.close();
      } catch (e) {}
      screenProducer = null;
      if (screenStream) {
        screenStream.getTracks().forEach(function (t) {
          t.stop();
        });
        screenStream = null;
      }
      if (btn) btn.classList.remove('active');
      toast('Screen share stopped');
      return;
    }
    if (!sendTransport) {
      toast('Not connected');
      return;
    }
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 15 },
        audio: false,
      });
      var track = screenStream.getVideoTracks()[0];
      track.onended = function () {
        if (screenProducer) toggleScreen();
      };
      screenProducer = await sendTransport.produce({
        track: track,
        appData: { source: 'screen' },
      });
      if (btn) btn.classList.add('active');
      toast('Sharing screen');
    } catch (e) {
      if (e.name !== 'NotAllowedError') toast('Screen share failed');
    }
  }

  function toggleNoise() {
    noiseSuppression = !noiseSuppression;
    var btn = $('#toggle-noise');
    if (btn) btn.classList.toggle('active', noiseSuppression);
    toast(noiseSuppression ? 'Noise on (next device change)' : 'Noise off (next device change)');
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
    } catch (e) {
      mediaRecorder = new MediaRecorder(localStream);
    }
    mediaRecorder.ondataavailable = function (e) {
      if (e.data.size) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = function () {
      recordingIndicator.classList.add('hidden');
      var rb = $('#toggle-record');
      if (rb) rb.classList.remove('danger-active');
      var blob = new Blob(recordedChunks, { type: 'video/webm' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'room-' + roomId + '-' + Date.now() + '.webm';
      a.click();
      URL.revokeObjectURL(url);
      toast('Recording saved');
      mediaRecorder = null;
    };
    mediaRecorder.start(1000);
    recordingIndicator.classList.remove('hidden');
    var rb2 = $('#toggle-record');
    if (rb2) rb2.classList.add('danger-active');
    toast('Recording…');
  }

  function startStats() {
    stopStats();
    statsTimer = setInterval(async function () {
      var lines = [];
      try {
        if (sendTransport) {
          (await sendTransport.getStats()).forEach(function (r) {
            if (r.type === 'outbound-rtp' && !r.isRemote) {
              lines.push('↑ ' + r.kind + ': ' + Math.round((r.bytesSent || 0) / 1024) + ' KB');
            }
          });
        }
        if (recvTransport) {
          (await recvTransport.getStats()).forEach(function (r) {
            if (r.type === 'inbound-rtp' && !r.isRemote) {
              lines.push(
                '↓ ' +
                  r.kind +
                  ': ' +
                  Math.round((r.bytesReceived || 0) / 1024) +
                  ' KB, lost ' +
                  (r.packetsLost || 0)
              );
            }
          });
        }
      } catch (e) {}
      if (lines.length) {
        statsContent.textContent = '';
        lines.forEach(function (l) {
          var d = document.createElement('div');
          d.textContent = l;
          statsContent.appendChild(d);
        });
      } else {
        statsContent.innerHTML = '<p class="muted">Collecting…</p>';
      }
    }, 2000);
  }

  function stopStats() {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(function () {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
    }, 25000);
  }

  function stopPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  async function loadDevices() {
    try {
      var devices = await navigator.mediaDevices.enumerateDevices();
      function fill(sel, kind) {
        if (!sel) return;
        var prev = sel.value;
        sel.innerHTML = '';
        devices
          .filter(function (d) {
            return d.kind === kind;
          })
          .forEach(function (d) {
            var opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || kind + ' ' + (sel.options.length + 1);
            sel.appendChild(opt);
          });
        if (prev) sel.value = prev;
      }
      fill(selectCamera, 'videoinput');
      fill(selectMic, 'audioinput');
      fill(selectSpeaker, 'audiooutput');
    } catch (e) {
      console.warn(e);
    }
  }

  async function switchDevices() {
    if (!localStream || !sendTransport) return;
    var videoId = selectCamera && selectCamera.value;
    var audioId = selectMic && selectMic.value;
    try {
      var constraints = {
        audio: {
          deviceId: audioId ? { exact: audioId } : undefined,
          echoCancellation: true,
          noiseSuppression: noiseSuppression,
          autoGainControl: true,
        },
        video: camEnabled
          ? {
              deviceId: videoId ? { exact: videoId } : undefined,
              width: { ideal: 1280 },
              height: { ideal: 720 },
            }
          : false,
      };
      var newStream = await navigator.mediaDevices.getUserMedia(constraints);
      var newAudio = newStream.getAudioTracks()[0];
      var newVideo = newStream.getVideoTracks()[0];

      if (newAudio && audioProducer) {
        await audioProducer.replaceTrack({ track: newAudio });
        localStream.getAudioTracks().forEach(function (t) {
          localStream.removeTrack(t);
          t.stop();
        });
        localStream.addTrack(newAudio);
      }
      if (newVideo && videoProducer) {
        await videoProducer.replaceTrack({ track: newVideo });
        localStream.getVideoTracks().forEach(function (t) {
          localStream.removeTrack(t);
          t.stop();
        });
        localStream.addTrack(newVideo);
      } else if (newVideo && !videoProducer && camEnabled) {
        localStream.getVideoTracks().forEach(function (t) {
          localStream.removeTrack(t);
          t.stop();
        });
        localStream.addTrack(newVideo);
        videoProducer = await sendTransport.produce({
          track: newVideo,
          appData: { source: 'camera' },
        });
      }

      localVideo.srcObject = localStream;
      applyMicCamState();
      startLocalMeter();
      applySpeaker();
    } catch (e) {
      console.error(e);
      toast('Could not switch device');
    }
  }

  async function applySettings() {
    var newName = (settingsName.value || '').trim().slice(0, 32);
    if (newName && newName !== displayName && peerId) {
      displayName = newName;
      localName.textContent = displayName;
      await request('updateDisplayName', { displayName: displayName }).catch(function () {});
      updateParticipants();
    }
    localVideo.classList.toggle('mirror', mirrorLocal.checked);
    var sfu = (settingsSfuUrl.value || '').trim();
    if (sfu) localStorage.setItem('sfuUrl', sfu.replace(/\/ws$/, ''));
    if (peerId) {
      await switchDevices();
      applySpeaker();
    }
    settingsModal.classList.add('hidden');
    toast('Settings applied');
  }

  joinForm.addEventListener('submit', function (e) {
    e.preventDefault();
    joinRoom(
      (displayNameInput.value || '').trim() || 'Guest',
      (roomIdInput.value || '').trim(),
      roomPinInput ? (roomPinInput.value || '').trim() : ''
    );
  });

  $('#leave-btn').addEventListener('click', function () {
    leaveRoom(false);
  });
  $('#toggle-mic').addEventListener('click', function () {
    toggleMic();
  });
  $('#toggle-cam').addEventListener('click', function () {
    toggleCam();
  });
  $('#toggle-screen').addEventListener('click', function () {
    toggleScreen();
  });
  $('#toggle-noise').addEventListener('click', function () {
    toggleNoise();
  });
  $('#toggle-record').addEventListener('click', function () {
    toggleRecord();
  });
  $('#toggle-reactions').addEventListener('click', function () {
    reactionsBar.classList.toggle('hidden');
  });
  $('#toggle-participants').addEventListener('click', function () {
    $('#participants-panel').classList.toggle('hidden');
    $('#chat-panel').classList.add('hidden');
    $('#stats-panel').classList.add('hidden');
  });
  $('#toggle-chat').addEventListener('click', function () {
    $('#chat-panel').classList.toggle('hidden');
    $('#participants-panel').classList.add('hidden');
    $('#stats-panel').classList.add('hidden');
  });
  $('#toggle-stats').addEventListener('click', function () {
    $('#stats-panel').classList.toggle('hidden');
    $('#participants-panel').classList.add('hidden');
    $('#chat-panel').classList.add('hidden');
  });
  $('#toggle-settings').addEventListener('click', function () {
    settingsName.value = displayName;
    settingsSfuUrl.value =
      localStorage.getItem('sfuUrl') || defaultSfuUrl().replace(/\/ws$/, '');
    loadDevices();
    settingsModal.classList.remove('hidden');
  });
  $('#close-settings').addEventListener('click', function () {
    settingsModal.classList.add('hidden');
  });
  $('#apply-settings').addEventListener('click', function () {
    applySettings();
  });

  $$('.close-panel').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var id = btn.dataset.panel;
      if (id) {
        var el = $('#' + id);
        if (el) el.classList.add('hidden');
      }
    });
  });

  reactionsBar.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-emoji]');
    if (!btn) return;
    var emoji = btn.dataset.emoji;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'reaction', emoji: emoji }));
    showFloatingReaction(emoji);
  });

  chatForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = (chatInput.value || '').trim();
    if (!text) return;
    if (!peerId) {
      toast('Join a room first');
      return;
    }
    request('chat', { text: text }).catch(function () {
      toast('Chat failed');
    });
    chatInput.value = '';
  });

  $('#copy-room').addEventListener('click', function () {
    navigator.clipboard.writeText(roomId || '').then(function () {
      toast('Room ID copied');
    });
  });
  $('#copy-invite').addEventListener('click', function () {
    var u = new URL(location.href);
    u.searchParams.set('room', roomId || '');
    var sfu = localStorage.getItem('sfuUrl');
    if (sfu) u.searchParams.set('sfu', sfu.indexOf('/ws') !== -1 ? sfu : sfu + '/ws');
    navigator.clipboard.writeText(u.toString()).then(function () {
      toast('Invite link copied');
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.target.matches('input, textarea, select')) return;
    if (call.classList.contains('hidden')) return;
    var k = e.key.toLowerCase();
    if (k === 'm') toggleMic();
    else if (k === 'c') toggleCam();
    else if (k === 's' && !e.metaKey && !e.ctrlKey) toggleScreen();
    else if (k === 'escape') {
      $$('.side-panel').forEach(function (p) {
        p.classList.add('hidden');
      });
      reactionsBar.classList.add('hidden');
      settingsModal.classList.add('hidden');
    }
  });

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', function () {
      loadDevices();
    });
  }

  var qRoom = qs('room');
  var qName = qs('name');
  if (qRoom) roomIdInput.value = qRoom;
  if (qName) displayNameInput.value = qName;
  displayNameInput.value =
    displayNameInput.value || localStorage.getItem('displayName') || '';
  displayNameInput.addEventListener('change', function () {
    localStorage.setItem('displayName', (displayNameInput.value || '').trim());
  });

  $('#toggle-noise').classList.add('active');
  console.log('[WebRTC Room] client ready');
})();
