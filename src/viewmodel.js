import { BATTLE_MODES } from './modes.js?v=1';
import { round2 } from './pyround.js?v=2';

const CANVAS = 1000.0;
const OUT_OF_FRAME = 50;

// Дальняя позиция устаревает до двух секунд, поэтому рядом с точной она не нужна.
const FAR_MERGE_SEC = 0.75;
// Шкала начинается до нуля, чтобы было видно метки, которые ставят до старта боя.
const PRE_START_LIMIT = -90;
const DESTRUCTION_WINDOW_SEC = 15;
// Точная поломка известна с точностью до объекта, поэтому рядом считаются
// поломки в тридцати метрах. Без таблицы карты остаётся центр квадрата, и
// сближать такие точки можно только на размер квадрата.
const DESTRUCTION_RADIUS_M = 30;
const DESTRUCTION_SPREAD_M = 12;
const DESTRUCTION_CHUNK_RADIUS_M = 160;
const DESTRUCTION_CHUNK_SPREAD_M = 80;

/** Точная дорожка дополняется дальними точками там, где точных нет. */
function mergeTracks(precise, far) {
  if (!far.length) return precise;
  if (!precise.length) return far.slice().sort((a, b) => a.t - b.t);

  const times = precise.map((pt) => pt.t);
  const merged = precise.slice();
  for (const pt of far) {
    let lo = 0;
    let hi = times.length - 1;
    let gap = Infinity;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      gap = Math.min(gap, Math.abs(times[mid] - pt.t));
      if (times[mid] < pt.t) lo = mid + 1;
      else hi = mid - 1;
    }
    if (gap > FAR_MERGE_SEC) merged.push(pt);
  }
  merged.sort((a, b) => a.t - b.t);
  return merged;
}

/** Метки на карте: отдельные точки, каждая со своим временем. */
function buildMapPoints(marks, teamOf, worldToScreen) {
  const points = [];

  for (const mark of marks || []) {
    if (!mark.player || !Number.isFinite(mark.x) || !Number.isFinite(mark.z)) continue;
    const [x, y] = worldToScreen(mark.x, mark.z);
    points.push({ t: mark.time, x, y, player: mark.player, team: teamOf(mark.player) });
  }

  points.sort((a, b) => a.t - b.t);
  return points;
}

/**
 * Одиночная поломка показывается меткой, а серия рядом — стрелкой в сторону,
 * куда ломают объекты.
 */
function buildDestructionMarks(events, worldToScreen) {
  const clusters = [];
  const list = [...(events || [])].sort((a, b) => a.time - b.time);
  const exact = list.length && list.filter((event) => event.exact).length * 2 >= list.length;
  const radius = exact ? DESTRUCTION_RADIUS_M : DESTRUCTION_CHUNK_RADIUS_M;
  const spread = exact ? DESTRUCTION_SPREAD_M : DESTRUCTION_CHUNK_SPREAD_M;

  for (const event of list) {
    const fit = clusters.find((cluster) => event.time - cluster.end <= DESTRUCTION_WINDOW_SEC
      && Math.hypot(event.x - cluster.cx, event.z - cluster.cz) <= radius);

    if (fit) {
      fit.pts.push(event);
      fit.end = event.time;
      fit.cx = fit.pts.reduce((sum, pt) => sum + pt.x, 0) / fit.pts.length;
      fit.cz = fit.pts.reduce((sum, pt) => sum + pt.z, 0) / fit.pts.length;
    } else {
      clusters.push({ start: event.time, end: event.time, cx: event.x, cz: event.z, pts: [event] });
    }
  }

  return clusters.map((cluster) => {
    const { pts } = cluster;
    const half = Math.floor(pts.length / 2);
    const head = pts.slice(0, half || 1);
    const tail = pts.slice(half || 1);
    const mid = (part, key) => part.reduce((sum, pt) => sum + pt[key], 0) / part.length;

    const mark = {
      t: cluster.start,
      t_end: cluster.end,
      count: pts.length,
    };
    const [cx, cy] = worldToScreen(cluster.cx, cluster.cz);
    mark.x = cx;
    mark.y = cy;

    if (pts.length >= 3 && tail.length) {
      const reach = Math.hypot(mid(tail, 'x') - mid(head, 'x'), mid(tail, 'z') - mid(head, 'z'));
      if (reach >= spread) {
        const [x1, y1] = worldToScreen(mid(head, 'x'), mid(head, 'z'));
        const [x2, y2] = worldToScreen(mid(tail, 'x'), mid(tail, 'z'));
        mark.x = x1;
        mark.y = y1;
        mark.x2 = x2;
        mark.y2 = y2;
      }
    }
    return mark;
  });
}

export function findMapImages(mapNameTech, fileList = null) {
  const cleanName = String(mapNameTech || '').replace(/[^\w-]/g, '_').toLowerCase();

  if (fileList === null) {
    if (!cleanName) return [null, null];
    return [`${cleanName}_low.png`, `${cleanName}.png`];
  }

  const exts = ['.png', '.webp', '.jpg', '.jpeg'];
  const files = fileList.filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)));
  const stemOf = (f) => f.slice(0, f.lastIndexOf('.'));

  let low = null;
  let high = null;
  for (const f of files) {
    const stem = stemOf(f).toLowerCase();
    if (stem.startsWith(cleanName)) {
      if (stem.includes('_low')) low = f;
      else high = f;
    }
  }
  if (!low || !high) {
    for (const f of files) {
      const stem = stemOf(f).toLowerCase();
      const nameLower = f.toLowerCase();
      if (nameLower.includes(cleanName) || cleanName.includes(stem.replace('_low', '')) || stem.includes(cleanName)) {
        if (stem.includes('_low') && !low) low = f;
        else if (!stem.includes('_low') && !high) high = f;
      }
    }
  }
  return [low, high];
}

function splitDateTime(battleDatetime) {
  const text = battleDatetime || '';
  if (!text) return ['', ''];
  const parts = text.split(' ');
  if (parts.length < 2) return ['', ''];
  const time = parts[1].split(':');
  return [parts[0], time.length >= 2 ? `${time[0]}:${time[1]}` : ''];
}

export function buildMapView(data, { mapFileList = null } = {}) {
  const meta = data.meta || {};
  const playersRaw = data.players || [];

  const mapNameTech = meta.map_name_tech ?? 'unknown';
  const mapDisplayName = meta.map_name_ru || mapNameTech;
  const myTeam = String(meta.creator_team ?? '1');
  const startClock = meta.battle_start_clock || 0.0;

  const captureTimeline = [];
  for (const cap of meta.capture_timeline || []) {
    const capTime = round2((cap.time ?? 0) - startClock);
    if (capTime < 0) continue;
    captureTimeline.push({
      time: capTime,
      team: cap.team ?? null,
      base_index: cap.base_index ?? 0,
      players_capturing: cap.players_capturing ?? 0,
      percent: cap.percent ?? 0,
      seconds_remaining: cap.seconds_remaining ?? null,
    });
  }

  const [battleDateDisplay, battleTimeDisplay] = splitDateTime(meta.battle_datetime);
  const [mapImgLow, mapImgHigh] = findMapImages(mapNameTech, mapFileList);

  const mapBounds = meta.map_bounds_and_bases || {};
  const bbox = mapBounds.bounding_box || {};
  const bl = bbox.bottom_left;
  const ur = bbox.upper_right;

  let minX; let maxX; let minZ; let maxZ;
  if (bl && ur) {
    [minX, minZ] = [Number(bl[0]), Number(bl[1])];
    [maxX, maxZ] = [Number(ur[0]), Number(ur[1])];
  } else {
    const xs = [];
    const zs = [];
    for (const p of playersRaw) for (const c of p.coordinates || []) { xs.push(c.x); zs.push(c.z); }
    if (xs.length && zs.length) {
      const padding = 50;
      minX = Math.min(...xs) - padding; maxX = Math.max(...xs) + padding;
      minZ = Math.min(...zs) - padding; maxZ = Math.max(...zs) + padding;
    } else {
      minX = -500.0; maxX = 500.0; minZ = -500.0; maxZ = 500.0;
    }
  }
  const rangeX = maxX !== minX ? maxX - minX : 1000.0;
  const rangeZ = maxZ !== minZ ? maxZ - minZ : 1000.0;

  const worldToScreen = (wx, wz) => {
    const nx = ((wx - minX) / rangeX) * CANVAS;
    const nz = ((wz - minZ) / rangeZ) * CANVAS;
    return [nx, CANVAS - nz];
  };

  // Начало шкалы — момент, когда на карте уже все, кто появляется до боя.
  const spawnTimes = playersRaw
    .map((p) => (p.coordinates || [])[0]?.time)
    .filter((t) => typeof t === 'number' && t < 0);
  const minTime = spawnTimes.length ? Math.max(Math.max(...spawnTimes), PRE_START_LIMIT) : 0;

  const damageEvents = [];
  const seen = new Set();

  const addDamageEvent = (evTime, attacker, target, ev) => {
    const key = `${evTime} ${target} ${attacker}`;
    if (seen.has(key)) return;
    seen.add(key);

    const isDestroyed = Boolean(ev.is_destroyed) || ((ev.damage ?? 0) > 0 && ev.new_hp === 0);
    if (ev.is_ricochet && !isDestroyed) return;

    damageEvents.push({
      time: evTime,
      attacker,
      target,
      damage: ev.damage ?? 0,
      is_destroyed: isDestroyed,
      new_hp: ev.new_hp ?? null,
      old_hp: ev.old_hp ?? null,
      // Причина урона: 0 — выстрел, 1 — пожар, 2 — таран, 3 — столкновение с картой.
      reason: ev.reason ?? 0,
      crits: (ev.crits || []).map((crit) => ({ name: crit.name, destroyed: Boolean(crit.destroyed) })),
    });
  };

  for (const pdata of playersRaw) {
    const pname = pdata.display_name;
    for (const ev of pdata.damage_dealt || []) {
      const t = round2((ev.time ?? 0) - startClock);
      if (t < 0) continue;
      addDamageEvent(t, pname, ev.target ?? '', ev);
    }
    for (const ev of pdata.damage_received || []) {
      const t = round2((ev.time ?? 0) - startClock);
      if (t < 0) continue;
      addDamageEvent(t, ev.attacker ?? 'unknown', pname, ev);
    }
  }

  damageEvents.sort((a, b) => a.time - b.time);

  const players = [];
  const positions = {};
  const deaths = {};

  for (const pdata of playersRaw) {
    const pname = pdata.display_name;
    const finalStats = pdata.final_stats || {};
    const isDestroyed = Boolean(finalStats.is_destroyed);
    const killedBy = finalStats.killed_by || '';

    const playerObj = {
      id: pname,
      name: pname,
      team: parseInt(String(pdata.team ?? 1), 10),
      max_hp: pdata.max_hp ?? 0,
      clan: pdata.clan ?? '',
      tank_name: pdata.tank_short_name || pdata.tank_type_no_nation || '',
      tank_code: pdata.tank_type_full ?? '',
    };

    const toScreenPts = (coords, extra) => {
      const pts = [];
      for (const coord of coords || []) {
        const t = coord.time ?? 0;
        if (t < minTime) continue;
        const { x: wx, z: wz } = coord;
        if (!Number.isFinite(wx) || !Number.isFinite(wz)) continue;
        const [sx, sy] = worldToScreen(wx, wz);
        if (sx >= -OUT_OF_FRAME && sx <= CANVAS + OUT_OF_FRAME
            && sy >= -OUT_OF_FRAME && sy <= CANVAS + OUT_OF_FRAME) {
          pts.push({ t, x: sx, y: sy, ...extra });
        }
      }
      return pts;
    };

    const pathPts = mergeTracks(toScreenPts(pdata.coordinates), toScreenPts(pdata.far_coordinates, { f: 1 }));

    if (pathPts.length) {
      positions[pname] = pathPts;
      players.push(playerObj);

      if (isDestroyed) {
        let deathTime = null;
        let deathX = pathPts[pathPts.length - 1].x;
        let deathY = pathPts[pathPts.length - 1].y;

        for (const ev of damageEvents) {
          if (ev.target === pname && ev.is_destroyed) { deathTime = ev.time; break; }
        }

        if (deathTime === null && killedBy) {
          let ricochetDeathTime = null;
          for (const ev of pdata.damage_received || []) {
            const t = round2((ev.time ?? 0) - startClock);
            if (t < 0) continue;
            if (ev.is_ricochet && ev.damage === 0 && (ev.attacker ?? '') === killedBy) {
              ricochetDeathTime = t;
            }
          }
          if (ricochetDeathTime !== null) {
            deathTime = ricochetDeathTime;
            damageEvents.push({
              time: deathTime,
              attacker: killedBy,
              target: pname,
              damage: 0,
              is_destroyed: true,
              new_hp: 0,
              old_hp: 0,
            });
          }
        }

        if (deathTime === null) {
          const times = (pdata.damage_received || [])
            .map((ev) => round2((ev.time ?? 0) - startClock))
            .filter((t) => t >= 0);
          if (times.length) deathTime = Math.max(...times);
        }
        if (deathTime === null) deathTime = pathPts[pathPts.length - 1].t;

        for (const pt of pathPts) {
          if (pt.t <= deathTime) { deathX = pt.x; deathY = pt.y; }
        }

        deaths[pname] = { t: deathTime, x: deathX, y: deathY, pid: pname };
      }
    } else {
      players.push(playerObj);
      if (isDestroyed) deaths[pname] = { t: 0, x: 500, y: 500, pid: pname };
    }
  }

  damageEvents.sort((a, b) => a.time - b.time);

  let durationSec = meta.battle_duration_sec;
  if (durationSec === null || durationSec === undefined) {
    let maxCoordTime = 0;
    for (const p of playersRaw) {
      for (const c of p.coordinates || []) if ((c.time ?? 0) > maxCoordTime) maxCoordTime = c.time ?? 0;
    }
    durationSec = Math.max(0, maxCoordTime - 5);
  }

  const mapMarkers = [];
  for (const [teamTag, bases] of Object.entries(mapBounds.team_base_positions || {})) {
    const teamNum = teamTag.replace('team', '');
    bases.forEach((pos, i) => {
      const [sx, sy] = worldToScreen(pos[0], pos[1]);
      const idx = i + 1;
      mapMarkers.push({
        type: 'base', x: sx, y: sy,
        icon: teamNum === myTeam ? `Base_${idx}_our.png` : `Base_${idx}.png`,
        team: teamNum, number: idx,
      });
    });
  }
  // Натиск на части карт идёт за одну точку захвата вместо баз команды.
  // Номер у неё тот, что приходит в прогрессе захвата.
  if (!mapMarkers.length && mapBounds.control_point) {
    const [sx, sy] = worldToScreen(mapBounds.control_point[0], mapBounds.control_point[1]);
    const captured = [...new Set(captureTimeline
      .filter((cap) => cap.percent > 0 || cap.players_capturing > 0)
      .map((cap) => cap.base_index))];
    mapMarkers.push({
      type: 'base', x: sx, y: sy, icon: 'Base_N.png',
      team: null, number: captured.length === 1 ? captured[0] : 1,
    });
  }
  for (const [teamTag, pos] of Object.entries(mapBounds.team_spawn_points || {})) {
    const teamNum = teamTag.replace('team', '');
    const [sx, sy] = worldToScreen(pos[0], pos[1]);
    mapMarkers.push({
      type: 'spawn', x: sx, y: sy,
      icon: teamNum === myTeam ? 'Spawn_1_our.png' : 'Spawn_1.png',
      team: teamNum, number: 1,
    });
  }

  const teamOf = (name) => players.find((p) => p.id === name)?.team ?? null;
  const firstSpotted = {};
  for (const pdata of playersRaw) {
    if (pdata.first_spotted != null) firstSpotted[pdata.display_name] = pdata.first_spotted;
  }

  return {
    min_time: minTime,
    map_marks: buildMapPoints(meta.map_marks, teamOf, worldToScreen),
    reload_calls: (meta.reload_calls || []).filter((call) => call.player && call.time >= 0),
    destruction: buildDestructionMarks(meta.destruction_events, worldToScreen),
    first_spotted: firstSpotted,
    map_display_name: mapDisplayName,
    map_img_low: mapImgLow,
    map_img_high: mapImgHigh,
    game_version: meta.game_version ?? '',
    battle_time: battleTimeDisplay,
    battle_date_display: battleDateDisplay,
    my_team: myTeam,
    my_clan: meta.creator_clan ?? '',
    enemy_clan: meta.enemy_clan ?? '',
    team_health: meta.team_health ?? { 1: 0, 2: 0 },
    duration_sec: durationSec,
    winner_team: meta.winner_team ?? null,
    finish_reason_code: meta.finish_reason_code ?? null,
    battle_mode: BATTLE_MODES[meta.battle_type]?.key ?? null,
    players,
    positions,
    deaths: Object.values(deaths),
    damage_events: damageEvents,
    map_markers: mapMarkers,
    capture_timeline: captureTimeline,
  };
}

export function buildHitsView(data) {
  const meta = data.meta || {};
  const startClock = meta.battle_start_clock || 0.0;

  const shots = [];
  for (const shot of data.shots || []) {
    const relTime = round2((shot.hit_clock ?? 0) - startClock);
    if (relTime < 0) continue;
    shots.push({ ...shot, hit_clock: relTime });
  }

  // Странице нужны броня и колёса только тех машин, по которым били.
  const armor = {};
  const wheels = {};
  for (const shot of shots) {
    const type = shot.victim_tank_raw;
    if (!type || armor[type]) continue;
    const plates = data.vehicle_db?.[type]?.armor;
    if (plates) armor[type] = plates;
    const wheelList = data.vehicle_db?.[type]?.wheels;
    if (wheelList?.length) wheels[type] = wheelList;
  }

  const [battleDateDisplay, battleTimeDisplay] = splitDateTime(meta.battle_datetime);

  return {
    map_display_name: meta.map_name_ru || meta.map_name_tech || 'unknown',
    battle_date_display: battleDateDisplay,
    battle_time_display: battleTimeDisplay,
    shots,
    armor,
    wheels,
    battle_type: meta.battle_type ?? null,
    my_team: String(meta.creator_team ?? '1'),
    ally_clan: meta.creator_clan ?? '',
    enemy_clan: meta.enemy_clan ?? '',
  };
}
