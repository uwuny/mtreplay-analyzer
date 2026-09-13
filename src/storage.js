const DB_NAME = 'mtreplay';

import { BATTLE_MODES } from './modes.js?v=1';

export { BATTLE_MODES };

const DB_VERSION = 7;

// Версии, в которых менялся формат отчёта: сохранённые отчёты старше надо разобрать заново.
const REPORT_FORMAT_VERSIONS = [5, 6, 7];
const SUMMARIES = 'summaries';
const REPORTS = 'reports';

// Размер команды в режимах, которых нет в BATTLE_MODES.
const DEFAULT_TEAM_SIZE = 7;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SUMMARIES)) db.createObjectStore(SUMMARIES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(REPORTS)) db.createObjectStore(REPORTS, { keyPath: 'id' });
      if (event.oldVersion > 0 && event.oldVersion < DB_VERSION) {

        request.transaction.objectStore(SUMMARIES).clear();

        if (REPORT_FORMAT_VERSIONS.some((v) => event.oldVersion < v && v <= DB_VERSION)) {
          request.transaction.objectStore(REPORTS).clear();
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function runTx(db, stores, mode, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    result = work(tx);
  });
}

const asPromise = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export async function putBattle(id, summary, report) {
  const db = await openDb();
  return runTx(db, [SUMMARIES, REPORTS], 'readwrite', (tx) => {
    tx.objectStore(SUMMARIES).put({ ...summary, id });
    tx.objectStore(REPORTS).put({ id, report });
  });
}

export async function listSummaries() {
  const db = await openDb();
  return asPromise(db.transaction(SUMMARIES, 'readonly').objectStore(SUMMARIES).getAll());
}

export async function getReport(id) {
  const db = await openDb();
  const row = await asPromise(db.transaction(REPORTS, 'readonly').objectStore(REPORTS).get(id));
  return row ? row.report : null;
}

export async function existingIds() {
  const db = await openDb();
  const keys = await asPromise(db.transaction(SUMMARIES, 'readonly').objectStore(SUMMARIES).getAllKeys());
  return new Set(keys);
}

export async function deleteBattle(id) {
  const db = await openDb();
  return runTx(db, [SUMMARIES, REPORTS], 'readwrite', (tx) => {
    tx.objectStore(SUMMARIES).delete(id);
    tx.objectStore(REPORTS).delete(id);
  });
}

export async function clearAll() {
  const db = await openDb();
  return runTx(db, [SUMMARIES, REPORTS], 'readwrite', (tx) => {
    tx.objectStore(SUMMARIES).clear();
    tx.objectStore(REPORTS).clear();
  });
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

export function makeSummary(report) {
  const meta = report.meta;
  const personal = meta.creator_personal_clan || '';
  const ownLabel = personal ? `${meta.creator_name}[${personal}]` : String(meta.creator_name || '');
  const own = report.players.find((p) => p.display_name === ownLabel) || {};
  const stats = own.final_stats || {};

  let alliesDestroyed = 0;
  let enemiesDestroyed = 0;
  for (const p of report.players) {
    if (!p.final_stats?.is_destroyed) continue;
    if (p.team === meta.creator_team) alliesDestroyed++;
    else enemiesDestroyed++;
  }

  // В неполном реплее противник известен только засвеченный, так что вторая
  // команда может быть неполной или вовсе пустой.
  const incomplete = Boolean(meta.incomplete);
  const teamSize = BATTLE_MODES[meta.battle_type]?.teamSize ?? DEFAULT_TEAM_SIZE;
  const teamSizes = new Map();
  for (const p of report.players) teamSizes.set(p.team, (teamSizes.get(p.team) || 0) + 1);
  const offFormat = !report.players.length
    || teamSizes.size > 2
    || (!incomplete && teamSizes.size !== 2)
    || Math.max(...teamSizes.values()) > teamSize
    || report.players.length > teamSize * 2;

  const roster = report.players
    .filter((p) => p.team === meta.creator_team)
    .map((p) => {
      const s = p.final_stats || {};
      return {
        name: p.display_name.replace(/\[[^\]]*\]$/, ''),
        tank: p.tank_short_name || p.tank_type_no_nation || '',
        damage: s.damage_dealt ?? 0,
        damage_received: s.damage_received ?? 0,
        damage_blocked: s.damage_blocked ?? 0,
        assist: s.assist_total ?? 0,
        assist_track: s.assist_track ?? 0,
        assist_radio: s.assist_radio ?? 0,
        kills: s.kills ?? 0,
        shots: s.shots ?? 0,
        hits: s.hits ?? 0,
        piercings: s.piercings ?? 0,
        spotted: s.spotted ?? 0,
        xp: s.xp ?? 0,
        alive: !s.is_destroyed,
      };
    });

  return {
    battle_datetime: meta.battle_datetime || '',
    map_name: meta.map_name_ru || meta.map_name_tech || '',
    map_name_tech: meta.map_name_tech || '',
    creator_clan: meta.creator_clan || '',
    enemy_clan: meta.enemy_clan || '',
    creator_personal_clan: meta.creator_personal_clan || '',
    creator_clan_id: meta.creator_clan_id ?? null,
    enemy_clan_id: meta.enemy_clan_id ?? null,
    creator_team: meta.creator_team ?? null,
    winner_team: meta.winner_team ?? null,
    finish_reason_name: meta.finish_reason_name || '',
    duration_sec: meta.battle_duration_sec ?? 0,
    enemies_destroyed: enemiesDestroyed,
    allies_destroyed: alliesDestroyed,
    tank: own.tank_short_name || own.tank_type_no_nation || '',
    damage_dealt: stats.damage_dealt ?? 0,
    damage_received: stats.damage_received ?? 0,
    damage_blocked: stats.damage_blocked ?? 0,
    assist_total: stats.assist_total ?? 0,
    kills: stats.kills ?? 0,
    shots: stats.shots ?? 0,
    hits: stats.hits ?? 0,
    piercings: stats.piercings ?? 0,
    spotted: stats.spotted ?? 0,
    survived: !stats.is_destroyed,
    life_time_sec: stats.life_time_sec ?? 0,
    total_players: meta.total_players ?? 0,
    battle_type: meta.battle_type ?? null,
    mode: BATTLE_MODES[meta.battle_type]?.key ?? null,
    incomplete,
    off_format: offFormat,
    shots_count: report.shots.length,
    xp: stats.xp ?? 0,
    roster,
  };
}

export async function rebuildSummaries() {
  const db = await openDb();
  const reports = await asPromise(db.transaction(REPORTS, 'readonly').objectStore(REPORTS).getAll());
  if (!reports.length) return [];

  const summaries = reports.map((row) => ({ ...makeSummary(row.report), id: row.id }));
  await runTx(db, [SUMMARIES], 'readwrite', (tx) => {
    const store = tx.objectStore(SUMMARIES);
    for (const s of summaries) store.put(s);
  });
  return summaries;
}
