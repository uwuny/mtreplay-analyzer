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

const ENTITY_ID_MIN = 1_000_000;
const ENTITY_ID_MAX = 100_000_000;

const isEntityId = (id) => id >= ENTITY_ID_MIN && id <= ENTITY_ID_MAX;

/**
 * Идентификаторы клиентских методов в потоке пакетов 0x08. Значения привязаны
 * к сборке клиента, поэтому каждый декодер дополнительно проверяет длину и
 * содержимое хвоста — при сдвиге нумерации метод просто не опознается.
 */
const METHOD = {
  SHOW_SHOOTING: 1,
  ON_HEALTH_CHANGED: 3,
  SHOW_DAMAGE_FROM_SHOT: 10,
  STOP_TRACER: 29,
  SHOW_TRACER: 38,
  SHOW_DAMAGED_DEVICES: 59,
  SHOW_SHOT_RESULTS: 60,
  BATTLE_EVENT: 66,
};

/** Vehicle.onHealthChanged: сколько HP снято и чем именно. */
function decodeHealthChanged(tail, view, victimId) {
  if (tail.length !== 9) return null;

  const newHp = view.getInt16(0, true);
  const oldHp = view.getInt16(2, true);
  const attackerId = view.getUint32(4, true);
  if (oldHp <= 0 || oldHp > 5000 || newHp > oldHp) return null;
  if (!isEntityId(victimId) || !isEntityId(attackerId)) return null;

  return {
    victim_id: victimId,
    attacker_id: attackerId,
    old_hp: oldHp,
    new_hp: newHp,
    // При добивании клиент присылает отрицательное здоровье: снятыми
    // считаются только те HP, что у машины оставались.
    damage: oldHp - Math.max(newHp, 0),
    is_destroyed: newHp <= 0,
    attack_reason: tail[8],
  };
}

/**
 * Vehicle.showDamageFromShot — приходит на каждое попадание, включая
 * непробития. Точки — отрезки, которые снаряд прошёл внутри узла техники,
 * координаты квантованы по габаритному ящику узла (0…255 на ось).
 */
function decodeDamageFromShot(tail, view) {
  if (tail.length < 12) return null;

  const segmentCount = tail[4];
  if (tail.length !== 5 + segmentCount * 8 + 3) return null;

  const attackerId = view.getUint32(0, true);
  if (!isEntityId(attackerId)) return null;

  const segments = [];
  for (let i = 0; i < segmentCount; i++) {
    const at = 5 + i * 8;
    segments.push({
      effect_code: tail[at],
      component: tail[at + 1],
      start: [tail[at + 2], tail[at + 3], tail[at + 4]],
      end: [tail[at + 5], tail[at + 6], tail[at + 7]],
    });
  }

  const extra = 5 + segmentCount * 8;
  return {
    attacker_id: attackerId,
    segments,
    effects_index: tail[extra],
    damage_factor: tail[extra + 1],
    last_material_is_shield: tail[extra + 2] !== 0,
  };
}

/** Avatar.showShotResults — битовые флаги исхода для собственных выстрелов. */
function decodeShotResults(tail, view) {
  const count = tail[0];
  if (!count || tail.length !== 1 + count * 8) return null;

  const results = [];
  for (let i = 0; i < count; i++) {
    const vehicleId = view.getUint32(1 + i * 8, true);
    if (!isEntityId(vehicleId)) return null;
    results.push({ vehicle_id: vehicleId, flags: view.getUint32(5 + i * 8, true) });
  }
  return results;
}

/** Avatar.showOtherVehicleDamagedDevices — индексы повреждённых модулей и экипажа. */
function decodeDamagedDevices(tail, view) {
  if (tail.length < 6) return null;

  const vehicleId = view.getUint32(0, true);
  if (!isEntityId(vehicleId)) return null;

  const damagedCount = tail[4];
  const destroyedAt = 5 + damagedCount;
  if (destroyedAt >= tail.length) return null;
  const destroyedCount = tail[destroyedAt];
  if (tail.length !== destroyedAt + 1 + destroyedCount) return null;

  return {
    vehicle_id: vehicleId,
    damaged: Array.from(tail.subarray(5, destroyedAt)),
    destroyed: Array.from(tail.subarray(destroyedAt + 1)),
  };
}

/** Avatar.showTracer — старт трассера: кто стрелял, чем и с какой скоростью. */
function decodeTracer(tail, view) {
  if (tail.length < 50) return null;

  const shooterId = view.getUint32(0, true);
  if (!isEntityId(shooterId)) return null;

  return {
    shooter_id: shooterId,
    shot_id: view.getUint32(4, true),
    is_ricochet: tail[8] !== 0,
    effects_index: tail[9],
    start: {
      x: round2(view.getFloat32(10, true)),
      y: round2(view.getFloat32(14, true)),
      z: round2(view.getFloat32(18, true)),
    },
    velocity: {
      x: round2(view.getFloat32(22, true)),
      y: round2(view.getFloat32(26, true)),
      z: round2(view.getFloat32(30, true)),
    },
  };
}

export function decodeBattleEvent(view, raw) {
  const result = {
    clock: round2(view.getFloat32(8, true)),
    player_id: view.getUint32(12, true),
  };
  if (view.byteLength < 24) return result;

  const methodId = view.getUint32(16, true);
  const tailLength = view.getUint32(20, true);
  result.method_id = methodId;

  const tail = raw.subarray(24, 24 + tailLength);
  if (tail.length !== tailLength) return result;
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  if (methodId === METHOD.BATTLE_EVENT && tailLength === 19 && tail.length >= 3) {
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
    return result;
  }

  if (methodId === METHOD.ON_HEALTH_CHANGED) {
    const event = decodeHealthChanged(tail, tailView, result.player_id);
    if (event) result.damage_event = event;
    return result;
  }

  if (methodId === METHOD.SHOW_DAMAGE_FROM_SHOT) {
    const hit = decodeDamageFromShot(tail, tailView);
    if (hit) result.hit = { victim_id: result.player_id, ...hit };
    return result;
  }

  if (methodId === METHOD.SHOW_SHOT_RESULTS) {
    const results = decodeShotResults(tail, tailView);
    if (results) result.shot_results = results;
    return result;
  }

  if (methodId === METHOD.SHOW_DAMAGED_DEVICES) {
    const devices = decodeDamagedDevices(tail, tailView);
    if (devices) result.damaged_devices = devices;
    return result;
  }

  if (methodId === METHOD.SHOW_TRACER) {
    const tracer = decodeTracer(tail, tailView);
    if (tracer) result.tracer = tracer;
    return result;
  }

  if (methodId === METHOD.STOP_TRACER && tailLength === 16) {
    result.tracer_end = {
      shot_id: tailView.getUint32(0, true),
      x: round2(tailView.getFloat32(4, true)),
      y: round2(tailView.getFloat32(8, true)),
      z: round2(tailView.getFloat32(12, true)),
    };
    return result;
  }

  if (methodId === METHOD.SHOW_SHOOTING && tailLength === 2 && isEntityId(result.player_id)) {
    result.shooting = { burst: tail[0], gun_index: tail[1] };
    return result;
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
