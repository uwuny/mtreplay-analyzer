import { loadPickle } from './pickle.js?v=1';
import { round2 } from './pyround.js?v=1';

const PICKLE_MARKER = [0x80, 0x02];

function findMarker(bytes, marker, from = 0) {
  const last = bytes.length - marker.length;
  outer: for (let i = from; i <= last; i++) {
    for (let j = 0; j < marker.length; j++) {
      if (bytes[i + j] !== marker[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function decodeMovement(view) {
  const size = view.byteLength;
  const result = {
    clock: round2(view.getFloat32(8, true)),
    player_id: view.getUint32(12, true),
    secondary_id: size >= 20 ? view.getUint32(16, true) : 0,
  };
  if (size >= 32) {
    result.position = {
      x: round2(view.getFloat32(20, true)),
      y: round2(view.getFloat32(24, true)),
      z: round2(view.getFloat32(28, true)),
    };
  }
  if (size >= 56) {
    result.hull_orientation = {
      yaw: round4(view.getFloat32(44, true)),
      pitch: round4(view.getFloat32(48, true)),
      roll: round4(view.getFloat32(52, true)),
    };
  }
  return result;
}

export function decodeBattlePhase(view) {
  return { clock: round2(view.getFloat32(8, true)) };
}

export function decodeAim(view) {
  const result = { clock: round2(view.getFloat32(8, true)) };
  if (view.byteLength >= 72) {
    result.point_a = {
      x: round2(view.getFloat32(12, true)),
      y: round2(view.getFloat32(16, true)),
      z: round2(view.getFloat32(20, true)),
    };
  }
  return result;
}

export function decodeBattleEvent(view, raw) {
  const result = {
    clock: round2(view.getFloat32(8, true)),
    player_id: view.getUint32(12, true),
  };
  if (view.byteLength < 24) return result;

  const field16 = view.getUint32(16, true);
  const tailLength = view.getUint32(20, true);
  result.field16 = field16;
  result.tail_length = tailLength;

  const tail = raw.subarray(24, 24 + tailLength);

  if (tailLength === 19 && field16 === 66 && tail.length >= 3) {
    try {
      const at = findMarker(tail, PICKLE_MARKER);
      if (at !== -1) {
        const obj = loadPickle(tail.subarray(at));
        if (Array.isArray(obj) && obj.length === 6) {
          result.capture_progress = {
            base_index: obj[1],
            percent: obj[2],
            seconds_remaining: obj[3],
            player_count: obj[4],
          };
        }
      }
    } catch {   }
  }

  if (tailLength === 9 && tail.length >= 8) {
    const victimId = result.player_id;
    const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    const newHp = tailView.getUint16(0, true);
    const oldHp = tailView.getUint16(2, true);
    const attackerId = tailView.getUint32(4, true);
    if (newHp <= 5000 && oldHp <= 5000 && newHp <= oldHp
        && victimId >= 1_000_000 && victimId <= 100_000_000
        && attackerId >= 1_000_000 && attackerId <= 100_000_000) {
      result.damage_event = {
        victim_id: victimId,
        attacker_id: attackerId,
        old_hp: oldHp,
        new_hp: newHp,
        damage: oldHp - newHp,
        is_destroyed: newHp === 0,
      };
    }
  }

  return result;
}

function round4(x) {

  const scaled = Math.abs(x);
  if (!Number.isFinite(scaled)) return x;
  const s = scaled.toFixed(20);
  const dot = s.indexOf('.');
  const kept = s.slice(dot + 1, dot + 5);
  const rest = s.slice(dot + 5);
  let n = Number(s.slice(0, dot) + kept);
  const first = rest.charCodeAt(0) - 48;
  let up;
  if (first > 5) up = true;
  else if (first < 5) up = false;
  else if (/[1-9]/.test(rest.slice(1))) up = true;
  else up = n % 2 === 1;
  if (up) n += 1;
  const out = n / 10000;
  return x < 0 ? -out : out;
}

export const REPORT_DECODERS = {
  0x0a: decodeMovement,
  0x08: decodeBattleEvent,
  0x1a: decodeAim,
  0x2b: decodeBattlePhase,
};
