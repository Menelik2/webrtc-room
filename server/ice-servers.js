/**
 * Optional browser ICE servers (STUN/TURN) passed to clients on join.
 * mediasoup is ICE-Lite: STUN is rarely needed; TURN helps hard NAT.
 */
'use strict';

function loadIceServers() {
  const raw = process.env.ICE_SERVERS || process.env.MEDIASOUP_ICE_SERVERS || '';
  if (!raw || !String(raw).trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn('[ice] ICE_SERVERS must be a JSON array');
      return [];
    }
    return parsed.filter((s) => s && (s.urls || s.url));
  } catch (e) {
    console.warn('[ice] ICE_SERVERS is not valid JSON:', e.message);
    return [];
  }
}

module.exports = { loadIceServers };
