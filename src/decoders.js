import { loadPickle } from './pickle.js?v=2';
import { round2, roundTo } from './pyround.js?v=3';

const PICKLE_MARKER = [0x80, 0x02];
const latin = new TextDecoder('latin1');

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
  UPDATE_ARENA: 66,
  UPDATE_POSITIONS: 67,
};

/**
 * Типы обновлений арены (ARENA_UPDATE), нужные для списка машин. VEHICLE_UPDATED
 * приходит, когда игрок сменил технику на отсчёте (в Натиске её выбирают уже
 * на арене) или когда у противника впервые открылся тип машины.
 */
export const ARENA_UPDATE = {
  VEHICLE_LIST: 1,
  VEHICLE_ADDED: 2,
  VEHICLE_UPDATED: 11,
};

const ARENA_VEHICLE_UPDATES = new Set(Object.values(ARENA_UPDATE));

/** Номер сущности AreaDestructibles — квадрата карты с разрушаемыми объектами. */
export const ENTITY_DESTRUCTIBLES = 7;

/**
 * Разрушаемые объекты квадрата: четыре массива подряд, в порядке описания
 * сущности. Номер массива приходит в пути к свойству, размер записи от него
 * же и зависит.
 */
export const DESTRUCTIBLE_KIND = {
  MODULE: 0,
  FRAGILE: 1,
  COLUMN: 2,
  TREE: 3,
};

const DESTRUCTIBLE_RECORD = { 0: 3, 1: 3, 2: 3, 3: 5 };

/** Команды командного чата: рисование на карте и объявление перезарядки. */
export const CHAT_ACTION = {
  ATTENTION_TO_POSITION: 30,
  RELOADING_GUN: 44,
};

/** Длина в аргументах BigWorld: один байт, либо 0xFF и три байта. */
function readPackedLength(tail, at) {
  if (tail[at] !== 0xff) return [tail[at], at + 1];
  return [tail[at + 1] | (tail[at + 2] << 8) | (tail[at + 3] << 16), at + 4];
}

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

  if (methodId === METHOD.UPDATE_ARENA) {
    const [size, at] = readPackedLength(tail, 1);
    // Список машин арены приходит сжатым: под туманом войны он пополняется по ходу боя.
    if (ARENA_VEHICLE_UPDATES.has(tail[0]) && size > 0 && at + size <= tail.length) {
      result.arena_update = { type: tail[0], data: tail.subarray(at, at + size) };
      return result;
    }

    if (tailLength === 19 && tail.length >= 3) {
      try {
        const marker = findMarker(tail, PICKLE_MARKER);
        if (marker !== -1) {
          const obj = loadPickle(tail.subarray(marker));
          if (Array.isArray(obj) && obj.length === 6) {
            result.capture_progress = {
              team: obj[0],
              base_index: obj[1],
              percent: obj[2],
              seconds_remaining: obj[3],
              player_count: obj[4],
            };
          }
        }
      } catch {   }
    }
    return result;
  }

  if (methodId === METHOD.UPDATE_POSITIONS) {
    const positions = decodeFarPositions(tail, tailView);
    if (positions) result.far_positions = positions;
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
  return roundTo(x, 4);
}

/**
 * Avatar.updatePositions — позиции машин за пределами зоны отрисовки: индекс в
 * отсортированном списке машин арены и пара x, z в метрах, раз в 2 секунды.
 */
function decodeFarPositions(tail, view) {
  const [count, at] = readPackedLength(tail, 0);
  if (!count) return null;

  const [values, from] = readPackedLength(tail, at + count);
  if (values !== count * 2 || from + values * 2 !== tail.length) return null;

  const positions = [];
  for (let i = 0; i < count; i++) {
    positions.push({
      index: tail[at + i],
      x: view.getInt16(from + i * 4, true),
      z: view.getInt16(from + i * 4 + 2, true),
    });
  }
  return positions;
}

/** Сущность вошла в зону отрисовки: id, тип и позиция появления. */
export function decodeEntityCreate(view) {
  const result = {
    clock: round2(view.getFloat32(8, true)),
    entity_id: view.getUint32(12, true),
    entity_type: view.getUint16(16, true),
  };
  if (view.byteLength >= 42) {
    result.position = {
      x: round2(view.getFloat32(30, true)),
      y: round2(view.getFloat32(34, true)),
      z: round2(view.getFloat32(38, true)),
    };
  }
  return result;
}

/**
 * Сломался конкретный объект: забор, дерево, часть дома. Приходит как
 * изменение вложенного свойства сущности-квадрата карты.
 *
 * Тело: [u32 сущность][u8 срез][u32 длина][биты пути][запись]. В пути четыре
 * бита на номер свойства (8, 10, 12, 14 — четыре массива разрушаемых), затем
 * границы среза; запись выровнена по байту, поэтому её достаточно взять с
 * конца тела. В самой записи — номер объекта внутри квадрата.
 */
export function decodeDestructibles(view, raw) {
  const result = {
    clock: round2(view.getFloat32(8, true)),
    entity_id: view.getUint32(12, true),
  };
  if (view.byteLength < 22) return result;

  const size = view.getUint32(17, true);
  const body = raw.subarray(21, 21 + size);
  if (body.length !== size) return result;

  const kind = (body[0] >> 5) - 4;
  const record = DESTRUCTIBLE_RECORD[kind];
  if (record === undefined || (body[0] & 0x10) || body.length <= record) return result;

  const value = body.subarray(body.length - record);
  result.destructible = {
    kind,
    index: (value[0] << 8) | value[1],
  };
  return result;
}

/** Вектор из строки в аргументах чата: три float32 подряд. */
function chatPosition(text) {
  if (typeof text !== 'string' || text.length !== 12) return null;
  const bytes = new Uint8Array(12);
  for (let i = 0; i < 12; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  const view = new DataView(bytes.buffer);
  return {
    x: round2(view.getFloat32(0, true)),
    y: round2(view.getFloat32(4, true)),
    z: round2(view.getFloat32(8, true)),
  };
}

/**
 * Событие, которое клиент записал в реплей сам: имя, затем pickle. Из них нужен
 * командный чат — рисование на карте и объявления о перезарядке.
 */
export function decodeReplayEvent(view, raw) {
  const result = { clock: round2(view.getFloat32(8, true)) };
  if (view.byteLength < 16) return result;

  const nameLength = view.getUint32(12, true);
  const nameEnd = 16 + nameLength;
  if (nameEnd + 4 > raw.length) return result;
  if (latin.decode(raw.subarray(16, nameEnd)) !== 'bw_chat2.onActionReceived') return result;

  const size = view.getUint32(nameEnd, true);
  const body = raw.subarray(nameEnd + 4, nameEnd + 4 + size);
  if (body.length !== size) return result;

  try {
    const action = loadPickle(body);
    if (!Array.isArray(action) || action.length < 3) return result;
    const args = action[2];
    if (!args || typeof args !== 'object') return result;

    result.chat = {
      action: action[0],
      vehicle_id: args.int64Arg1 ?? null,
      index: args.int32Arg1 ?? null,
      seconds: args.floatArg1 ?? 0,
      position: chatPosition(args.strArg2),
    };
  } catch {   }
  return result;
}

export const REPORT_DECODERS = {
  0x05: decodeEntityCreate,
  0x08: decodeBattleEvent,
  0x0a: decodeMovement,
  0x1a: decodeAim,
  0x24: decodeDestructibles,
  0x2b: decodeBattlePhase,
  0x31: decodeReplayEvent,
};
