import { loadMapXml } from './bigworld.js?v=3';
import { ARENA_UPDATE, CHAT_ACTION, ENTITY_DESTRUCTIBLES, REPORT_DECODERS } from './decoders.js?v=5';
import { chunkIdFromPosition, loadDestructibles } from './destructibles.js?v=1';
import { inflate, parseReplay } from './mtreplay.js?v=2';
import { loadPickle } from './pickle.js?v=2';
import { round2 } from './pyround.js?v=2';
import { BATTLE_MODES } from './modes.js?v=1';
import { buildVehicleDb, buildVehicleTypeResolver, effectKind } from './vehicles.js?v=4';

const FINISH_REASON_NAMES = {
  1: 'уничтожение техники / истечение времени',
  2: 'захват базы',
};

const ASSIST_KEYS = [
  'damageAssistedTrack', 'damageAssistedRadio', 'damageAssistedStun',
  'damageAssistedSmoke', 'damageAssistedInspire',
];

export function parseTanksDb(text) {
  const db = {};
  for (const line of text.split('\n')) {
    const parts = line.replace(/\r$/, '').split('\t');
    if (parts.length < 4) continue;
    db[parts[3].trim()] = { short: parts[1].trim(), full: parts[2].trim() };
  }
  return db;
}

function stripNation(vehicleType) {
  if (!vehicleType) return '';
  const at = vehicleType.indexOf(':');
  return at === -1 ? vehicleType : vehicleType.slice(at + 1);
}

function readableTankName(vehicleType, tanksDb) {
  const short = tanksDb[vehicleType]?.short || '';
  return short || stripNation(vehicleType).replaceAll('_', ' ');
}

function formatNameClan(name, clan) {
  if (!name) return 'Неизвестно';
  return clan ? `${name}[${clan}]` : name;
}

function buildEntityInfo(replay) {
  const pi = replay.playerInfo;
  const perEntityBasic = (Array.isArray(pi) && pi.length > 1 && pi[1] && typeof pi[1] === 'object') ? pi[1] : {};
  const vehiclesStats = (Array.isArray(pi) && pi[0] && typeof pi[0] === 'object') ? (pi[0].vehicles || {}) : {};

  const info = new Map();
  for (const [eidStr, basic] of Object.entries(perEntityBasic)) {
    const eid = Number(eidStr);
    const statsList = vehiclesStats[eidStr] || vehiclesStats[String(eid)];
    const vstats = (statsList && statsList[0]) || {};
    info.set(eid, {
      name: basic.name ?? null,
      team: basic.team ?? null,
      clan: basic.clanAbbrev || '',
      max_hp: basic.maxHealth ?? null,
      vehicle_type_full: basic.vehicleType || '',
      account_dbid: vstats.accountDBID ?? null,
      final_stats_raw: vstats,
    });
  }
  return info;
}

// Поля строки в списке машин арены.
const ARENA_ROW = {
  VEHICLE_ID: 0, COMPACT_DESCR: 1, NAME: 2, TEAM: 3, ACCOUNT_DBID: 7, CLAN: 8, CLAN_DBID: 9, MAX_HEALTH: 24,
};

/**
 * Реплей, записанный не до конца (выход из боя, вылет клиента), итогового блока
 * не содержит. Состав тогда собирается из списка арены, который пополняется по
 * мере засвета противника. Тип машины берётся из последнего её описания: в
 * Натиске технику меняют на отсчёте, и в начале боя у союзников записан ещё
 * прежний выбор — он остаётся только запасным вариантом.
 */
async function buildEntityInfoFromArena(replay, inflateFn, resolveType) {
  const info = new Map();
  for (const [eidStr, v] of Object.entries(replay.gameBegin?.vehicles || {})) {
    info.set(Number(eidStr), {
      name: v.name ?? null,
      team: v.team ?? null,
      clan: v.clanAbbrev || '',
      max_hp: v.maxHealth ?? null,
      vehicle_type_full: v.vehicleType || '',
      account_dbid: null,
      final_stats_raw: {},
    });
  }

  const clanDbids = new Map();
  for (const p of replay.packets) {
    const update = p.decoded?.arena_update;
    if (!update) continue;
    let rows;
    try {
      rows = loadPickle(await inflateFn(update.data));
    } catch {
      continue;
    }

    for (const row of update.type === ARENA_UPDATE.VEHICLE_LIST ? rows : [rows]) {
      if (!Array.isArray(row) || !Number.isInteger(row[ARENA_ROW.VEHICLE_ID])) continue;
      const eid = row[ARENA_ROW.VEHICLE_ID];
      const known = info.get(eid);
      const accountDbid = row[ARENA_ROW.ACCOUNT_DBID] ?? null;
      info.set(eid, {
        name: row[ARENA_ROW.NAME] ?? known?.name ?? null,
        team: row[ARENA_ROW.TEAM] ?? known?.team ?? null,
        clan: row[ARENA_ROW.CLAN] || known?.clan || '',
        max_hp: row[ARENA_ROW.MAX_HEALTH] || known?.max_hp || null,
        vehicle_type_full: await resolveType(row[ARENA_ROW.COMPACT_DESCR]) || known?.vehicle_type_full || '',
        account_dbid: accountDbid,
        final_stats_raw: known?.final_stats_raw || {},
      });
      if (accountDbid !== null) clanDbids.set(accountDbid, row[ARENA_ROW.CLAN_DBID] || null);
    }
  }
  return { info, clanDbids };
}

/** Итогов нет — гибель и убийца берутся из снятия HP до нуля. */
function fillDeathsFromHealth(packets, entityInfo) {
  for (const p of packets) {
    const dmg = p.type === 0x08 ? p.decoded?.damage_event : null;
    if (!dmg?.is_destroyed) continue;
    const raw = entityInfo.get(dmg.victim_id)?.final_stats_raw;
    if (!raw) continue;
    raw.deathCount = 1;
    raw.killerID = dmg.attacker_id;
  }
}

/** «10.09.2026 18:59:27» из начала боя — в формат отчёта. */
function parseBeginDatetime(text) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}:\d{2}:\d{2})$/.exec(String(text || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]} ${m[4]}` : null;
}

export function buildTeamClans(entityInfo, clanDbidByAccount) {
  const tagCounts = new Map();
  const dbidCounts = new Map();

  for (const info of entityInfo.values()) {
    const tag = info.clan;
    const team = info.team;
    if (!tag || team === null || team === undefined) continue;

    if (!tagCounts.has(team)) { tagCounts.set(team, new Map()); dbidCounts.set(team, new Map()); }
    const tags = tagCounts.get(team);
    tags.set(tag, (tags.get(tag) || 0) + 1);

    const dbid = clanDbidByAccount.get(info.account_dbid);
    if (dbid) {
      const perTag = dbidCounts.get(team);
      if (!perTag.has(tag)) perTag.set(tag, new Map());
      const ids = perTag.get(tag);
      ids.set(dbid, (ids.get(dbid) || 0) + 1);
    }
  }

  const pickTop = (counts, compareKeys) => {
    let best = null;
    for (const [key, count] of counts) {
      if (best === null || count > best[1] || (count === best[1] && compareKeys(key, best[0]) < 0)) {
        best = [key, count];
      }
    }
    return best === null ? null : best[0];
  };

  const result = new Map();
  for (const [team, counts] of tagCounts) {
    const tag = pickTop(counts, (a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const ids = dbidCounts.get(team).get(tag);
    const clanId = ids ? pickTop(ids, (a, b) => a - b) : null;
    result.set(team, { clan: tag, clan_id: clanId });
  }
  return result;
}

function buildClanDbidLookup(replay) {
  const playersBlock = (replay.playerInfo && replay.playerInfo[0]?.players) || {};
  const map = new Map();
  for (const [dbidStr, p] of Object.entries(playersBlock)) {
    if (p && typeof p === 'object') map.set(Number(dbidStr), p.clanDBID ?? null);
  }
  return map;
}

function findBattleStartClock(packets) {
  const byClock = packets
    .map((p, index) => ({ p, index, clock: p.decoded?.clock ?? 0 }))

    .sort((a, b) => a.clock - b.clock || a.index - b.index);

  let moveStart = null;
  const firstPositions = new Map();
  for (const { p } of byClock) {
    if (p.type !== 0x0a || !p.decoded?.position) continue;
    const eid = p.decoded.player_id;
    const pos = p.decoded.position;
    const clock = p.decoded.clock;
    if (!firstPositions.has(eid)) {
      firstPositions.set(eid, [clock, pos.x, pos.z]);
      continue;
    }
    const [, x0, z0] = firstPositions.get(eid);
    if (Math.hypot(pos.x - x0, pos.z - z0) > 1.0) {
      moveStart = moveStart === null ? clock : Math.min(moveStart, clock);
    }
  }

  const markers = packets.filter((p) => p.type === 0x2b).map((p) => p.decoded.clock).sort((a, b) => a - b);
  if (moveStart !== null && markers.length) {
    const candidates = markers.filter((m) => m < moveStart);
    if (candidates.length) return Math.max(...candidates) + 0.5;
  }

  if (markers.length >= 3) return markers[2] + 0.5;
  return null;
}

function buildCoordinates(packets, entityIds, startClock) {
  const coords = new Map();
  for (const eid of entityIds) coords.set(eid, []);

  for (const p of packets) {
    if (p.type !== 0x0a) continue;
    const pos = p.decoded?.position;
    const eid = p.decoded?.player_id;
    if (!pos || !coords.has(eid)) continue;
    coords.get(eid).push({
      time: round2(p.decoded.clock - startClock),
      x: pos.x,
      z: pos.z,
    });
  }
  return coords;
}

function buildDamageLists(packets, entityInfo, critEvents) {
  const dealt = new Map();
  const received = new Map();
  for (const eid of entityInfo.keys()) {
    dealt.set(eid, []);
    received.set(eid, []);
  }

  const label = (eid) => {
    const info = entityInfo.get(eid);
    return info ? formatNameClan(info.name, info.clan) : 'Неизвестно';
  };

  const events = [];
  for (const p of packets) {
    if (p.type !== 0x08) continue;
    const dmg = p.decoded?.damage_event;
    if (!dmg) continue;

    // Список критов общий у обеих копий события: он дополняется уже после разбора.
    const crits = [];
    const base = {
      time: round2(p.decoded.clock),
      damage: dmg.damage,
      is_ricochet: dmg.damage === 0,
      old_hp: dmg.old_hp,
      new_hp: dmg.new_hp,
      reason: dmg.attack_reason ?? 0,
      crits,
    };
    if (dealt.has(dmg.attacker_id)) dealt.get(dmg.attacker_id).push({ ...base, target: label(dmg.victim_id) });
    if (received.has(dmg.victim_id)) received.get(dmg.victim_id).push({ ...base, attacker: label(dmg.attacker_id) });
    events.push({ victim_id: dmg.victim_id, time: base.time, crits });
  }

  attachCrits(events, critEvents);
  return { dealt, received };
}

/** Крит приписывается последнему попаданию по этой машине — как и в списке выстрелов. */
function attachCrits(damageEvents, critEvents) {
  for (const event of critEvents) {
    let owner = null;
    for (const row of damageEvents) {
      if (row.victim_id !== event.vehicle_id) continue;
      const delay = event.clock - row.time;
      if (delay < -MATCH_WINDOW_SEC || delay > CRIT_WINDOW_SEC) continue;
      if (!owner || row.time > owner.time) owner = row;
    }
    if (!owner) continue;

    const add = (name, destroyed) => {
      if (!owner.crits.some((crit) => crit.name === name && crit.destroyed === destroyed)) {
        owner.crits.push({ name, destroyed });
      }
    };
    for (const name of event.damaged) add(name, false);
    for (const name of event.destroyed) add(name, true);
  }
}

function buildCaptureTimeline(packets) {
  const timeline = [];
  for (const p of packets) {
    if (p.type === 0x08 && p.decoded?.capture_progress) {
      const cap = p.decoded.capture_progress;
      timeline.push({
        time: round2(p.decoded.clock),
        // Команда, которой принадлежит база: в стандартном бою у каждой своя.
        team: cap.team ?? null,
        base_index: cap.base_index,
        players_capturing: cap.player_count,
        percent: cap.percent,
        seconds_remaining: cap.seconds_remaining,
      });
    }
  }
  return timeline;
}

function nearestByClock(records, targetClock) {
  if (!records || records.length === 0) return null;
  let best = records[0];
  let bestDelta = Math.abs(records[0][0] - targetClock);
  for (let i = 1; i < records.length; i++) {
    const delta = Math.abs(records[i][0] - targetClock);
    if (delta < bestDelta) {
      best = records[i];
      bestDelta = delta;
    }
  }
  return best[1];
}

// Коды из Vehicle.showDamageFromShot. Имён в клиентских данных нет, поэтому
// разбивка выведена сверкой 1200+ попаданий с фактическим уроном, с флагами
// Avatar.showShotResults и с углом встречи по коллизионной модели:
// 4/5/6 — материал пройден, 1 — рикошет (угол от 70°), 2/3 — не пробит
// (угол любой, приведённая броня не меньше пробития), 0 — пройден экран
// или гусеница.
const PIERCING_EFFECT_CODES = new Set([4, 5, 6]);
const RICOCHET_EFFECT_CODES = new Set([1]);
const BLOCKED_EFFECT_CODES = new Set([1, 2, 3]);

// Фугас наносит урон и без пробития: ненулевой коэффициент урона у него
// пробития не означает. Непробитие снимает не больше половины урона снаряда,
// пробитие — полный урон с разбросом ±25 %.
const EXPLOSIVE_KINDS = new Set(['HIGH_EXPLOSIVE']);
const EXPLOSIVE_PIERCED_DAMAGE_SHARE = 0.75;

// Биты Avatar.showShotResults, подтверждённые на собственных выстрелах:
// бит 5 ставится на непробитие (код 3), рикошет (код 1) несёт бит 3.
const HIT_FLAG_RICOCHET = 1 << 3;
const HIT_FLAG_PIERCED = 1 << 4;

const MATCH_WINDOW_SEC = 0.6;
const CRIT_WINDOW_SEC = 4.0;

// Причина урона в Vehicle.onHealthChanged: 0 — выстрел.
const ATTACK_REASON_SHOT = 0;

/**
 * Сводит попадания с событиями одного выстрела по ближайшему времени.
 * Разбор по порядку попаданий ошибается на автоматах заряжания: снаряды
 * серии прилетают чаще окна сверки, и урон пробития забирает соседнее
 * непробитие. Поэтому пары набираются от самых близких, а попадания
 * с меньшим rank получают события первыми.
 */
function pairByClock(hits, rows, match, rank = () => 0) {
  const candidates = [];
  hits.forEach((item, hitIndex) => {
    rows.forEach((row, rowIndex) => {
      const delta = Math.abs(row.clock - item.clock);
      if (delta <= MATCH_WINDOW_SEC && match(item, row)) {
        candidates.push({ hitIndex, rowIndex, delta, rank: rank(item) });
      }
    });
  });
  candidates.sort((a, b) => a.rank - b.rank || a.delta - b.delta || a.hitIndex - b.hitIndex);

  const paired = new Array(hits.length).fill(null);
  const used = new Set();
  for (const { hitIndex, rowIndex } of candidates) {
    if (paired[hitIndex] || used.has(rowIndex)) continue;
    paired[hitIndex] = rows[rowIndex];
    used.add(rowIndex);
  }
  return paired;
}

const EXTRA_LABELS = {
  engineHealth: 'двигатель',
  ammoBayHealth: 'боеукладка',
  fuelTankHealth: 'топливный бак',
  radioHealth: 'рация',
  gunHealth: 'орудие',
  turretRotatorHealth: 'поворот башни',
  surveyingDeviceHealth: 'приборы наблюдения',
  commanderHealth: 'командир',
  driverHealth: 'механик-водитель',
  radioman1Health: 'радист',
  radioman2Health: 'радист',
  gunner1Health: 'наводчик',
  gunner2Health: 'наводчик',
  loader1Health: 'заряжающий',
  loader2Health: 'заряжающий',
};

function extraLabel(name) {
  if (!name) return null;
  if (EXTRA_LABELS[name]) return EXTRA_LABELS[name];
  const track = /^(left|right)Track\d*Health$/.exec(name);
  if (track) return track[1] === 'left' ? 'левая гусеница' : 'правая гусеница';
  return name.replace(/Health$/, '');
}

/**
 * Клиент присылает не отдельный крит, а текущий список повреждённых и
 * уничтоженных модулей цели. Новым критом считается то, чего в прошлом
 * списке этой машины не было — так переживаются и ремонт, и повтор.
 */
function buildCritTimeline(packets, extras) {
  const previous = new Map();
  const events = [];

  for (const p of packets) {
    const devices = p.decoded?.damaged_devices;
    if (!devices) continue;

    const before = previous.get(devices.vehicle_id) || { damaged: [], destroyed: [] };
    const fresh = (current, old) => current
      .filter((index) => !old.includes(index))
      .map((index) => extraLabel(extras[index]))
      .filter(Boolean);

    const damaged = fresh(devices.damaged, before.damaged);
    const destroyed = fresh(devices.destroyed, before.destroyed);
    previous.set(devices.vehicle_id, devices);

    if (damaged.length || destroyed.length) {
      events.push({ clock: p.decoded.clock, vehicle_id: devices.vehicle_id, damaged, destroyed });
    }
  }
  return events;
}

/**
 * Исход попадания фугасом, нанёсшим урон. Сверено с итоговыми пробитиями
 * стрелков в случайных боях (арта, ОФ и HESH): код непробития в пути снаряда
 * или разрыв на экране — не пробил; урон от трёх четвертей снаряда или
 * добивание (урон упёрся в остаток HP) — пробил.
 */
function classifyExplosiveHit(hit, shell, health) {
  if (hit.last_material_is_shield) return 'no_penetration';
  if (hit.segments.some((segment) => BLOCKED_EFFECT_CODES.has(segment.effect_code))) return 'no_penetration';
  if (!health || !shell.damage || health.event.is_destroyed) return 'penetration';
  return health.event.damage >= shell.damage * EXPLOSIVE_PIERCED_DAMAGE_SHARE ? 'penetration' : 'no_penetration';
}

function classifyHit(hit, flags, shell = null, health = null) {
  if (hit.damage_factor > 0 && EXPLOSIVE_KINDS.has(shell?.kind)) return classifyExplosiveHit(hit, shell, health);
  if (hit.damage_factor > 0) return 'penetration';

  if (flags !== null) {
    if (flags & HIT_FLAG_RICOCHET) return 'ricochet';
    if (flags & HIT_FLAG_PIERCED) return 'no_damage';
  }

  const last = hit.segments[hit.segments.length - 1];
  if (!last) return 'no_penetration';
  if (PIERCING_EFFECT_CODES.has(last.effect_code)) return 'no_damage';
  if (RICOCHET_EFFECT_CODES.has(last.effect_code)) return 'ricochet';
  return 'no_penetration';
}

// Трассер летит со скоростью 0,8 от табличной скорости снаряда — сверено
// на 1200 выстрелах техники всех наций.
const TRACER_SPEED_FACTOR = 0.8;
const TRACER_WINDOW_SEC = 6.0;

/** Последний трассер этого стрелка с тем же эффектом, вылетевший до попадания. */
function findTracer(tracers, clock, hit) {
  let found = null;
  for (const row of tracers) {
    const lead = clock - row.clock;
    if (lead < -0.05 || lead > TRACER_WINDOW_SEC) continue;
    if (row.tracer.shooter_id !== hit.attacker_id || row.tracer.effects_index !== hit.effects_index) continue;
    if (!found || row.clock > found.clock) found = row;
  }
  return found ? found.tracer : null;
}

/**
 * Запись эффекта общая у снарядов одного вида: обычный и специальный
 * бронебойный у пушки неразличимы по ней. Летевший узнаётся по скорости трассера.
 */
function pickShell(shells, effectsIndex, tracer, effectNames = []) {
  let candidates = shells.filter((shell) => shell.effects_index === effectsIndex);
  // Снаряды, у которых запись эффекта не восстановилась, подходят к попаданию
  // этой машины того же вида — вид читается из имени эффекта в реплее.
  if (!candidates.length) {
    const unresolved = shells.filter((shell) => shell.effects_index === null);
    const kind = effectKind(effectNames[effectsIndex]);
    const sameKind = unresolved.filter((shell) => shell.kind === kind);
    candidates = sameKind.length ? sameKind : unresolved;
  }
  if (candidates.length < 2 || !tracer) return candidates[0] || null;

  const { x, y, z } = tracer.velocity;
  const speed = Math.hypot(x, y, z) / TRACER_SPEED_FACTOR;
  return candidates.reduce((best, shell) => (
    Math.abs((shell.speed ?? 0) - speed) < Math.abs((best.speed ?? 0) - speed) ? shell : best));
}

/**
 * Каждое попадание снарядом: куда пришлось, чем стреляли и почему получилось
 * именно так. Основа — Vehicle.showDamageFromShot, он приходит и на непробития;
 * к нему подтягиваются снятые HP, критованные модули, трассер выстрела и — для
 * выстрелов автора реплея — точные флаги исхода.
 */
function buildShots(packets, entityInfo, tanksDb, vehicleDb, critEvents, effectNames) {
  const positions = new Map();
  for (const p of packets) {
    if (p.type === 0x0a && p.decoded?.position) {
      const pid = p.decoded.player_id;
      if (!positions.has(pid)) positions.set(pid, []);
      positions.get(pid).push([p.decoded.clock, p.decoded]);
    }
  }

  const label = (eid) => {
    const info = entityInfo.get(eid);
    return info ? formatNameClan(info.name, info.clan) : 'Неизвестно';
  };
  const tankOf = (eid) => {
    const info = entityInfo.get(eid);
    if (!info) return ['', 'Неизвестно'];
    return [info.vehicle_type_full, readableTankName(info.vehicle_type_full, tanksDb)];
  };

  const healthEvents = [];
  const shotResults = [];
  const tracers = [];
  const hits = [];
  for (const p of packets) {
    if (p.type !== 0x08 || !p.decoded) continue;
    const clock = p.decoded.clock;
    if (p.decoded.hit) hits.push({ clock, hit: p.decoded.hit });
    if (p.decoded.tracer) tracers.push({ clock, tracer: p.decoded.tracer });
    if (p.decoded.damage_event) healthEvents.push({ clock, event: p.decoded.damage_event });
    if (p.decoded.shot_results) {
      for (const entry of p.decoded.shot_results) shotResults.push({ clock, entry });
    }
  }

  // Снятые HP берутся только от выстрела: таран и резервы того же игрока
  // приходят рядом по времени, но к снаряду отношения не имеют.
  const healthByHit = pairByClock(hits, healthEvents,
    ({ hit }, row) => row.event.attack_reason === ATTACK_REASON_SHOT
      && row.event.victim_id === hit.victim_id && row.event.attacker_id === hit.attacker_id,
    ({ hit }) => (hit.damage_factor > 0 ? 0 : 1));
  const resultByHit = pairByClock(hits, shotResults, ({ hit }, row) => row.entry.vehicle_id === hit.victim_id);

  const shots = [];
  hits.forEach(({ clock, hit }, hitIndex) => {
    const shooterState = nearestByClock(positions.get(hit.attacker_id), clock);
    const victimState = nearestByClock(positions.get(hit.victim_id), clock);

    const [attackerRaw, attackerTank] = tankOf(hit.attacker_id);
    const [victimRaw, victimTank] = tankOf(hit.victim_id);

    const health = healthByHit[hitIndex];
    const result = resultByHit[hitIndex];

    const flags = result ? result.entry.flags : null;
    const tracer = findTracer(tracers, clock, hit);
    const shell = pickShell(vehicleDb?.[attackerRaw]?.shells || [], hit.effects_index, tracer, effectNames);
    // Пробитие падает с расстоянием, которое пролетел снаряд. Точка вылета
    // трассера точнее позиции стрелка: та у невидимой машины устаревает.
    const origin = tracer?.start ?? shooterState?.position ?? null;
    const target = victimState?.position ?? null;

    shots.push({
      hit_clock: round2(clock),
      attacker_id: hit.attacker_id,
      attacker_name: label(hit.attacker_id),
      attacker_tank: attackerTank,
      attacker_tank_raw: attackerRaw,
      victim_id: hit.victim_id,
      victim_name: label(hit.victim_id),
      victim_tank: victimTank,
      victim_tank_raw: victimRaw,
      attacker_team: entityInfo.get(hit.attacker_id)?.team ?? null,
      victim_team: entityInfo.get(hit.victim_id)?.team ?? null,
      damage: health ? health.event.damage : 0,
      is_destroyed: health ? health.event.is_destroyed : false,
      outcome: classifyHit(hit, flags, shell, health),
      segments: hit.segments,
      effects_index: hit.effects_index,
      damage_factor: hit.damage_factor,
      last_material_is_shield: hit.last_material_is_shield,
      hit_flags: flags,
      shell,
      shot_origin: tracer?.start ?? null,
      shot_distance: origin && target
        ? round2(Math.hypot(target.x - origin.x, target.y - origin.y, target.z - origin.z))
        : null,
      crits_damaged: [],
      crits_destroyed: [],
      shooter_pos: shooterState?.position ?? null,
      shooter_ypr: shooterState?.hull_orientation ?? null,
      victim_pos: victimState?.position ?? null,
      victim_ypr: victimState?.hull_orientation ?? null,
    });
  });

  // Крит относится к последнему попаданию по этой машине.
  for (const event of critEvents) {
    let owner = null;
    for (const shot of shots) {
      if (shot.victim_id !== event.vehicle_id) continue;
      const delay = event.clock - shot.hit_clock;
      if (delay < -MATCH_WINDOW_SEC || delay > CRIT_WINDOW_SEC) continue;
      if (!owner || shot.hit_clock > owner.hit_clock) owner = shot;
    }
    if (!owner) continue;
    owner.crits_damaged.push(...event.damaged);
    owner.crits_destroyed.push(...event.destroyed);
  }

  shots.sort((a, b) => a.hit_clock - b.hit_clock);
  return shots;
}

/**
 * Позиции машин за зоной отрисовки: Avatar.updatePositions присылает не id машины,
 * а её место в отсортированном списке арены. Под туманом войны список пополняется
 * по ходу боя (противник добавляется в момент первого засвета), поэтому он ведётся
 * по шагам, а не берётся один раз на старте.
 */
async function buildFarPositions(packets, inflateFn) {
  const arena = new Set();
  const spotted = new Map();
  const far = new Map();
  let ids = [];

  for (const p of packets) {
    const decoded = p.decoded;
    if (!decoded) continue;

    if (decoded.arena_update) {
      // Смена техники не меняет состав арены, а значит и номера в списке.
      if (decoded.arena_update.type === ARENA_UPDATE.VEHICLE_UPDATED) continue;
      let rows = null;
      try {
        rows = loadPickle(await inflateFn(decoded.arena_update.data));
      } catch {
        continue;
      }

      if (decoded.arena_update.type === ARENA_UPDATE.VEHICLE_LIST) arena.clear();
      const list = decoded.arena_update.type === ARENA_UPDATE.VEHICLE_LIST ? rows : [rows];
      for (const row of Array.isArray(list) ? list : []) {
        const vehicleId = Array.isArray(row) ? row[0] : null;
        if (!Number.isInteger(vehicleId)) continue;
        if (!arena.has(vehicleId)) spotted.set(vehicleId, decoded.clock);
        arena.add(vehicleId);
      }
      ids = [...arena].sort((a, b) => a - b);
      continue;
    }

    if (!decoded.far_positions) continue;
    for (const item of decoded.far_positions) {
      const vehicleId = ids[item.index];
      if (vehicleId === undefined) continue;
      if (!far.has(vehicleId)) far.set(vehicleId, []);
      far.get(vehicleId).push({ clock: decoded.clock, x: item.x, z: item.z });
    }
  }

  return { far, spotted };
}

/**
 * Командный чат: рисование на карте (серии точек с шагом около 0,2 с) и объявления
 * о перезарядке. И то и другое приходит только по союзникам — чат командный.
 */
function buildChatMarks(packets, entityInfo, startClock) {
  const marks = [];
  const reloads = [];

  const label = (eid) => {
    const info = entityInfo.get(eid);
    return info ? formatNameClan(info.name, info.clan) : null;
  };

  for (const p of packets) {
    const chat = p.decoded?.chat;
    if (!chat || !entityInfo.has(chat.vehicle_id)) continue;
    const time = round2(p.decoded.clock - startClock);

    if (chat.action === CHAT_ACTION.ATTENTION_TO_POSITION && chat.position) {
      marks.push({ time, player: label(chat.vehicle_id), x: chat.position.x, z: chat.position.z });
    } else if (chat.action === CHAT_ACTION.RELOADING_GUN && chat.seconds > 0) {
      reloads.push({ time, player: label(chat.vehicle_id), seconds: round2(chat.seconds) });
    }
  }

  return { marks, reloads };
}

/**
 * Поломки объектов. Событие приходит на сущность-квадрат карты и несёт номер
 * сломанного объекта внутри квадрата, а координаты этого объекта лежат в
 * таблице карты. Без таблицы остаётся центр квадрата — точность 100 метров.
 * Квадраты приходят и уходят вместе с зоной отрисовки, так что поломки видны
 * только вокруг автора.
 */
function buildDestruction(packets, startClock, lookup) {
  const chunks = new Map();
  const events = [];

  for (const p of packets) {
    const decoded = p.decoded;
    if (!decoded) continue;

    if (p.type === 0x05) {
      if (decoded.entity_type === ENTITY_DESTRUCTIBLES && decoded.position) {
        chunks.set(decoded.entity_id, decoded.position);
      }
      continue;
    }
    if (p.type !== 0x24) continue;

    const chunk = chunks.get(decoded.entity_id);
    if (!chunk) continue;

    let x = chunk.x;
    let z = chunk.z;
    let exact = false;
    const item = decoded.destructible;
    if (lookup && item) {
      const chunkId = chunkIdFromPosition(chunk.x, chunk.z);
      const found = chunkId === null ? null : lookup(chunkId, item.index);
      if (found) {
        [x, z] = found;
        exact = true;
      }
    }
    events.push({
      time: round2(decoded.clock - startClock),
      x: round2(x),
      z: round2(z),
      kind: item ? item.kind : null,
      exact,
    });
  }

  return events;
}

function formatBattleDatetime(timestamp) {
  if (!timestamp) return null;
  const d = new Date(timestamp * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export async function buildReport(arrayBuffer, sourceName, deps) {
  const tanksDb = deps.tanksDb || {};
  const replay = await parseReplay(arrayBuffer, {
    decoders: REPORT_DECODERS,
    inflate: deps.inflate,
  });

  const packets = replay.packets;
  const gb = replay.gameBegin || {};
  const common = (replay.playerInfo && replay.playerInfo[0]?.common) || {};

  const incomplete = !Array.isArray(replay.playerInfo);
  let entityInfo;
  let clanDbidByAccount;
  if (incomplete) {
    const resolveType = deps.loadGameXml
      ? buildVehicleTypeResolver({ loadGameXml: deps.loadGameXml })
      : async () => '';
    ({ info: entityInfo, clanDbids: clanDbidByAccount } = await buildEntityInfoFromArena(
      replay, deps.inflate || inflate, resolveType));
  } else {
    entityInfo = buildEntityInfo(replay);
    clanDbidByAccount = buildClanDbidLookup(replay);
  }

  const ownAccountDbid = gb.playerID;
  let ownEntityId = null;
  for (const [eid, info] of entityInfo) {
    if (info.account_dbid === ownAccountDbid) { ownEntityId = eid; break; }
  }
  if (ownEntityId === null && gb.playerName) {

    for (const [eid, info] of entityInfo) {
      if (info.name === gb.playerName) { ownEntityId = eid; break; }
    }
  }
  const ownInfo = entityInfo.get(ownEntityId) || {};
  const ownTeam = ownInfo.team ?? null;

  const teamClans = buildTeamClans(entityInfo, clanDbidByAccount);
  const otherTeams = [...teamClans.keys()].filter((t) => t !== ownTeam).sort((a, b) => a - b);

  const ownClanEntry = teamClans.get(ownTeam) || {};
  const enemyClanEntry = otherTeams.length ? teamClans.get(otherTeams[0]) : {};

  // В случайном бою команда не клановая: самый частый тег в ней ничего не значит.
  const clanTeams = BATTLE_MODES[gb.battleType ?? common.bonusType]?.clanTeams !== false;
  const ownClan = clanTeams ? ownClanEntry.clan ?? '' : '';
  const ownClanDbid = clanTeams ? ownClanEntry.clan_id ?? null : null;
  const enemyClan = clanTeams ? enemyClanEntry.clan ?? '' : '';
  const enemyClanDbid = clanTeams ? enemyClanEntry.clan_id ?? null : null;

  const ownPersonalClan = ownInfo.clan ?? '';

  const startClock = findBattleStartClock(packets);
  const durationSec = common.duration ?? null;
  const endClock = (startClock !== null && durationSec !== null) ? startClock + durationSec : null;

  const mapName = gb.mapName || '';
  const mapBuffer = await deps.loadMapBuffer(mapName);
  const mapXml = loadMapXml(mapBuffer, `${mapName}.xml`, gb.gameplayID || '');

  // Таблица разрушаемых объектов карты: без неё поломки остаются с точностью
  // до квадрата, остальной отчёт от неё не зависит.
  let destructibles = null;
  if (deps.loadDestructiblesBuffer) {
    try {
      destructibles = loadDestructibles(await deps.loadDestructiblesBuffer(mapName));
    } catch {   }
  }

  const relativeTo = startClock ?? 0.0;
  const coordsByEntity = buildCoordinates(packets, [...entityInfo.keys()], relativeTo);
  const captureTimeline = buildCaptureTimeline(packets);

  // Броня и боекомплект — из распакованных игровых XML. Без них отчёт
  // остаётся рабочим, но у попаданий не будет ни толщины, ни типа снаряда.
  const vehicleTypes = [...entityInfo.values()].map((info) => info.vehicle_type_full).filter(Boolean);
  let vehicleDb = {};
  let extras = [];
  let effectNames = [];
  if (deps.loadGameXml) {
    try {
      const db = await buildVehicleDb(vehicleTypes, { loadGameXml: deps.loadGameXml });
      vehicleDb = db.vehicles;
      extras = db.extras;
      effectNames = db.effects;
    } catch (err) {
      console.warn('Не удалось прочитать данные техники:', err);
    }
  }

  const critEvents = buildCritTimeline(packets, extras);
  const { dealt, received } = buildDamageLists(packets, entityInfo, critEvents);
  const shots = buildShots(packets, entityInfo, tanksDb, vehicleDb, critEvents, effectNames);

  // Дальние позиции, метки и поломки не влияют на остальной отчёт: если что-то
  // из этого не разобралось, бой всё равно собирается.
  const { far, spotted } = await buildFarPositions(packets, deps.inflate || inflate);
  const { marks, reloads } = buildChatMarks(packets, entityInfo, relativeTo);
  const destruction = buildDestruction(packets, relativeTo, destructibles);
  if (incomplete) fillDeathsFromHealth(packets, entityInfo);

  const playersOut = [];
  for (const eid of [...entityInfo.keys()].sort((a, b) => a - b)) {
    const info = entityInfo.get(eid);
    const raw = info.final_stats_raw;

    const assistTotal = ASSIST_KEYS.reduce((sum, key) => sum + (raw[key] || 0), 0);
    const killerId = raw.killerID || 0;
    const isDestroyed = Boolean(raw.deathCount) || raw.health === 0;
    const killedBy = (isDestroyed && killerId && entityInfo.has(killerId))
      ? formatNameClan(entityInfo.get(killerId).name, entityInfo.get(killerId).clan)
      : null;

    playersOut.push({
      display_name: formatNameClan(info.name, info.clan),
      id: eid,
      team: info.team,
      clan: info.clan,
      tank_type_full: info.vehicle_type_full,
      tank_type_no_nation: stripNation(info.vehicle_type_full),
      tank_short_name: tanksDb[info.vehicle_type_full]?.short || '',
      max_hp: info.max_hp,
      damage_received: received.get(eid) || [],
      damage_dealt: dealt.get(eid) || [],
      final_stats: {
        damage_dealt: raw.damageDealt ?? 0,
        xp: raw.xp ?? 0,
        kills: raw.kills ?? 0,
        shots: raw.shots ?? 0,
        hits: raw.directHits ?? 0,
        piercings: raw.piercings ?? 0,
        damage_received: raw.damageReceived ?? 0,
        damage_blocked: raw.damageBlockedByArmor ?? 0,
        life_time_sec: raw.lifeTime ?? 0,
        mileage: raw.mileage ?? 0,
        spotted: raw.spotted ?? 0,
        assist_total: assistTotal,
        assist_track: raw.damageAssistedTrack ?? 0,
        assist_radio: raw.damageAssistedRadio ?? 0,
        assist_stun: raw.damageAssistedStun ?? 0,
        assist_smoke: raw.damageAssistedSmoke ?? 0,
        assist_inspire: raw.damageAssistedInspire ?? 0,

        damaged: raw.damaged ?? 0,

        capture_points: raw.capturePoints ?? 0,
        dropped_capture_points: raw.droppedCapturePoints ?? 0,

        hits_received: raw.directHitsReceived ?? 0,
        piercings_received: raw.piercingsReceived ?? 0,

        potential_damage_received: raw.potentialDamageReceived ?? 0,
        damage_received_from_invisibles: raw.damageReceivedFromInvisibles ?? 0,
        credits: raw.credits ?? 0,

        // null — итогов нет (реплей записан не до конца).
        health: raw.health ?? null,
        is_destroyed: isDestroyed,
        killed_by: killedBy,
      },
      coordinates: coordsByEntity.get(eid) || [],
      // Позиции за зоной отрисовки: раз в 2 секунды, метры округлены до целых.
      far_coordinates: (far.get(eid) || []).map((c) => ({
        time: round2(c.clock - relativeTo),
        x: c.x,
        z: c.z,
      })),
      // Момент первого засвета: для союзников список арены известен с начала боя.
      first_spotted: spotted.has(eid) && spotted.get(eid) - relativeTo > 1
        ? round2(spotted.get(eid) - relativeTo)
        : null,
    });
  }

  return {
    meta: {
      source_file: sourceName,
      map_name_tech: gb.mapName ?? null,
      map_name_ru: gb.mapDisplayName ?? null,
      battle_datetime: formatBattleDatetime(common.arenaCreateTime) ?? parseBeginDatetime(gb.dateTime),
      game_version: gb.clientVersionFromExe ?? null,
      // Тип боя (ARENA_BONUS_TYPE): 20 — Вылазки, 43 — Натиск.
      battle_type: gb.battleType ?? common.bonusType ?? null,
      // Реплей оборвался до конца боя: итоговой статистики и победителя нет.
      incomplete,
      creator_name: gb.playerName ?? null,
      creator_team: ownTeam,

      creator_clan: ownClan,
      creator_clan_id: ownClanDbid,
      creator_personal_clan: ownPersonalClan,
      enemy_clan: enemyClan,
      enemy_clan_id: enemyClanDbid,

      team_clans: Object.fromEntries(
        [...teamClans.entries()].sort((a, b) => a[0] - b[0]).map(([team, data]) => [String(team), data]),
      ),
      winner_team: common.winnerTeam ?? null,
      finish_reason_code: common.finishReason ?? null,
      finish_reason_name: FINISH_REASON_NAMES[common.finishReason] ?? 'неизвестно',
      team_health: common.teamHealth ?? null,
      battle_duration_sec: durationSec,
      battle_start_clock: startClock !== null ? round2(startClock) : null,
      battle_end_clock: endClock !== null ? round2(endClock) : null,
      total_players: entityInfo.size,
      map_bounds_and_bases: mapXml,
      capture_timeline: captureTimeline,
      map_marks: marks,
      reload_calls: reloads,
      destruction_events: destruction,
    },
    players: playersOut,
    shots,
    vehicle_db: vehicleDb,
  };
}
