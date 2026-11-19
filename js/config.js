// Central config. Swap PEER_OPTIONS host/port/path to use a self-hosted PeerServer.
export const GAME_TITLE = 'Gigawolf Extreme';
export const PROTOCOL_VERSION = 1;
// App release version, shown in the footer so stale cached clients are easy to spot.
// Keep in sync with package.json and index.html (tests enforce this). Bump it on EVERY change.
export const APP_VERSION = '1.33.0';

export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 8;
// Codes are stored, sent and put in invite links as plain letters (ABCDEFGH),
// and shown or typed as two chunks (ABCD-EFGH) so they are easier to read out loud.
export const normalizeRoomCode = (input) => String(input ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, ROOM_CODE_LENGTH);
export const formatRoomCode = (code) => {
  const half = ROOM_CODE_LENGTH / 2;
  return code.length > half ? `${code.slice(0, half)}-${code.slice(half)}` : code;
};
export const PEER_ID_PREFIX = 'gigawolf-';

export const PEER_OPTIONS = {
  host: '0.peerjs.com',
  port: 443,
  path: '/',
  secure: true,
  debug: 0,
  config: {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], // STUN only, no TURN
  },
};

export const CONNECT_TIMEOUT_MS = 10_000;
export const RETRY_DELAYS_MS = [1000, 2000, 5000]; // then every 5s
export const PING_INTERVAL_MS = 5000;
export const DEAD_AFTER_MS = 15_000;               // no message for this long => reconnect
export const HOST_REGISTER_RETRY_MS = 60_000;      // resume: keep trying to reclaim the ID
export const RESUME_MAX_AGE_MS = 2 * 60 * 60 * 1000;
