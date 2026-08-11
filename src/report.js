import { loadMapXml } from './bigworld.js?v=1';
import { REPORT_DECODERS } from './decoders.js?v=1';
import { parseReplay } from './mtreplay.js?v=1';
import { round2 } from './pyround.js?v=1';

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

function buildDamageLists(packets, entityInfo) {
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

  for (const p of packets) {
    if (p.type !== 0x08) continue;
    const dmg = p.decoded?.damage_event;
    if (!dmg) continue;

    const base = {
      time: round2(p.decoded.clock),
      damage: dmg.damage,
      is_ricochet: dmg.damage === 0,
      old_hp: dmg.old_hp,
      new_hp: dmg.new_hp,
    };
    if (dealt.has(dmg.attacker_id)) dealt.get(dmg.attacker_id).push({ ...base, target: label(dmg.victim_id) });
    if (received.has(dmg.victim_id)) received.get(dmg.victim_id).push({ ...base, attacker: label(dmg.attacker_id) });
  }

  return { dealt, received };
}

function buildCaptureTimeline(packets) {
  const timeline = [];
  for (const p of packets) {
    if (p.type === 0x08 && p.decoded?.capture_progress) {
      const cap = p.decoded.capture_progress;
      timeline.push({
        time: round2(p.decoded.clock),
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

function buildShots(packets, entityInfo, tanksDb) {
  const positions = new Map();
  for (const p of packets) {
    if (p.type === 0x0a && p.decoded?.position) {
      const pid = p.decoded.player_id;
      if (!positions.has(pid)) positions.set(pid, []);
      positions.get(pid).push([p.decoded.clock, p.decoded]);
    }
  }

  const aimRecords = packets
    .filter((p) => p.type === 0x1a)
    .map((p) => [p.decoded.clock, p.decoded]);

  const label = (eid) => {
    const info = entityInfo.get(eid);
    return info ? formatNameClan(info.name, info.clan) : 'Неизвестно';
  };
  const tankOf = (eid) => {
    const info = entityInfo.get(eid);
    if (!info) return ['', 'Неизвестно'];
    return [info.vehicle_type_full, readableTankName(info.vehicle_type_full, tanksDb)];
  };

  const shots = [];
  for (const p of packets) {
    if (p.type !== 0x08) continue;
    const dmg = p.decoded?.damage_event;
    if (!dmg || dmg.damage <= 0) continue;

    const clock = p.decoded.clock;
    const shooterState = nearestByClock(positions.get(dmg.attacker_id), clock);
    const victimState = nearestByClock(positions.get(dmg.victim_id), clock);
    const aim = nearestByClock(aimRecords, clock);

    const [attackerRaw, attackerTank] = tankOf(dmg.attacker_id);
    const [victimRaw, victimTank] = tankOf(dmg.victim_id);

    shots.push({
      hit_clock: round2(clock),
      attacker_id: dmg.attacker_id,
      attacker_name: label(dmg.attacker_id),
      attacker_tank: attackerTank,
      attacker_tank_raw: attackerRaw,
      victim_id: dmg.victim_id,
      victim_name: label(dmg.victim_id),
      victim_tank: victimTank,
      victim_tank_raw: victimRaw,
      attacker_team: entityInfo.get(dmg.attacker_id)?.team ?? null,
      victim_team: entityInfo.get(dmg.victim_id)?.team ?? null,
      damage: dmg.damage,
      shooter_pos: shooterState?.position ?? null,
      shooter_ypr: shooterState?.hull_orientation ?? null,
      victim_pos: victimState?.position ?? null,
      victim_ypr: victimState?.hull_orientation ?? null,
      impact_point: aim?.point_a ?? null,
    });
  }

  return shots;
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

  const entityInfo = buildEntityInfo(replay);
  const clanDbidByAccount = buildClanDbidLookup(replay);

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

  const ownClan = ownClanEntry.clan ?? '';
  const ownClanDbid = ownClanEntry.clan_id ?? null;
  const enemyClan = enemyClanEntry.clan ?? '';
  const enemyClanDbid = enemyClanEntry.clan_id ?? null;

  const ownPersonalClan = ownInfo.clan ?? '';

  const startClock = findBattleStartClock(packets);
  const durationSec = common.duration ?? null;
  const endClock = (startClock !== null && durationSec !== null) ? startClock + durationSec : null;

  const mapName = gb.mapName || '';
  const mapBuffer = await deps.loadMapBuffer(mapName);
  const mapXml = loadMapXml(mapBuffer, `${mapName}.xml`, gb.gameplayID || '');

  const coordsByEntity = buildCoordinates(packets, [...entityInfo.keys()], startClock ?? 0.0);
  const { dealt, received } = buildDamageLists(packets, entityInfo);
  const captureTimeline = buildCaptureTimeline(packets);
  const shots = buildShots(packets, entityInfo, tanksDb);

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

        health: raw.health ?? 0,
        is_destroyed: isDestroyed,
        killed_by: killedBy,
      },
      coordinates: coordsByEntity.get(eid) || [],
    });
  }

  return {
    meta: {
      source_file: sourceName,
      map_name_tech: gb.mapName ?? null,
      map_name_ru: gb.mapDisplayName ?? null,
      battle_datetime: formatBattleDatetime(common.arenaCreateTime),
      game_version: gb.clientVersionFromExe ?? null,
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
    },
    players: playersOut,
    shots,
  };
}
