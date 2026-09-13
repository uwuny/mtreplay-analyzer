import { BATTLE_MODES } from './modes.js?v=1';
import { STAT_ICON_MARKUP } from './stat_icons.js?v=2';

export const STAT_TYPES = [
  { key: 'damage', label: 'Урон', svgIcon: 'damage' },
  { key: 'damage_received', label: 'Получено', svgIcon: 'received' },
  { key: 'hits', label: 'Попадания', svgIcon: 'hits' },
  { key: 'assist', label: 'Ассист', svgIcon: 'assist' },
  { key: 'survival', label: 'Выживаемость', svgIcon: 'survival' },
];

const esc = (v) => String(v ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#x27;');

export function renderStatButtons(activeKey) {
  return STAT_TYPES.map((stat) => `
    <button type="button" class="stat-btn btn-runborder${stat.key === activeKey ? ' active' : ''}" data-stat="${stat.key}">
      <svg class="stat-btn__icon" viewBox="0 0 56 56" aria-hidden="true">${STAT_ICON_MARKUP[stat.svgIcon] ?? ''}</svg>
      <span>${stat.label}</span>
    </button>`).join('');
}

function cellValue(type, p) {
  switch (type) {
    case 'damage': return p.damage;
    case 'damage_received': return p.damage_received;

    case 'hits': return `${p.shots}/${p.hits}/${p.piercings}`;
    case 'assist': return p.assist_track + p.assist_radio;
    case 'survival': return 0;
    default: return 0;
  }
}

function penetrationRate(name, battles) {
  let hits = 0;
  let pierces = 0;
  for (const b of battles) {
    const p = (b.roster || []).find((x) => x.name === name);
    if (!p) continue;
    hits += p.hits;
    pierces += p.piercings;
  }
  return hits ? pierces / hits : 0;
}

export function buildGrid(summaries, type) {
  const battles = [...summaries].sort((a, b) =>
    String(a.battle_datetime).localeCompare(String(b.battle_datetime)));

  const players = new Map();
  battles.forEach((battle, index) => {
    for (const p of battle.roster || []) {
      if (!players.has(p.name)) players.set(p.name, {});
      players.get(p.name)[index] = {
        tank: p.tank,
        value: cellValue(type, p),
        assist_track: p.assist_track,
        assist_radio: p.assist_radio,
        alive: p.alive,
      };
    }
  });

  const averages = {};
  const survival = {};
  for (const [name, cells] of players) {
    let sum = 0;
    let count = 0;
    let alive = 0;
    let total = 0;
    battles.forEach((_, i) => {
      const cell = cells[i];
      if (!cell) return;
      total++;
      if (cell.alive) alive++;
      if (typeof cell.value === 'number') { sum += cell.value; count++; }
    });
    averages[name] = count ? Math.round(sum / count) : 0;
    survival[name] = total ? Math.round((alive / total) * 100) : 0;
  }

  const names = [...players.keys()].sort((a, b) => {
    if (type === 'hits') return penetrationRate(b, battles) - penetrationRate(a, battles);
    if (type === 'survival') return survival[b] - survival[a];
    return averages[b] - averages[a];
  });

  return { battles, players, names, averages, survival };
}

function summaryCell(battles) {
  const wins = battles.filter((b) => b.winner_team === b.creator_team).length;
  const rate = battles.length ? Math.round((wins / battles.length) * 100) : 0;
  return `<div class="elo-summary">Боёв: ${battles.length}</div>
          <div class="elo-summary__winrate">Побед: ${rate}%</div>`;
}

function avgDataCell(type, name, grid) {
  if (type === 'hits') return `<td>${Math.round(penetrationRate(name, grid.battles) * 100)}%</td>`;
  if (type === 'survival') return `<td>${grid.survival[name]}%</td>`;
  return `<td>${grid.averages[name].toLocaleString('ru')}</td>`;
}

function playerCell(type, cell) {
  if (!cell) return '<td></td>';
  const tank = `<span class="${cell.alive ? 'alive' : 'dead'}">${esc(cell.tank)}</span>`;
  if (type === 'survival') return `<td>${tank}</td>`;

  const value = type === 'assist'
    ? `${esc(cell.value)}<br><small class="assist-icons">`
      + `<img src="./icons/track.png" alt="Засвет с гусеницы"> ${esc(cell.assist_track)}`
      + ` &nbsp;|&nbsp; <img src="./icons/spot.png" alt="Засвет по рации"> ${esc(cell.assist_radio)}</small>`
    : esc(typeof cell.value === 'number' ? cell.value.toLocaleString('ru') : cell.value);

  return `<td>${tank}<br>${value}</td>`;
}

export function renderStatsTable(allSummaries, type, avgPosition = 'left') {
  // В неполном реплее нет итоговой статистики: нули испортили бы средние.
  // Статистика ведётся по составу клана, поэтому случайные бои с их
  // случайными союзниками в неё тоже не входят.
  const summaries = allSummaries.filter((s) => !s.incomplete
    && BATTLE_MODES[s.battle_type]?.clanTeams !== false);
  if (!summaries.length) return '<div class="stats-empty">Нет загруженных боёв</div>';

  const grid = buildGrid(summaries, type);
  const { battles, players, names } = grid;
  const avgLabel = type === 'hits' ? '%' : 'Среднее';

  const clanCells = battles.map((b) => {
    const tag = String(b.enemy_clan || '').toUpperCase();
    const link = tag
      ? `<a class="clan-link" href="https://hemero.ru/ru/ru2026may/personal.php?tag=${encodeURIComponent(tag)}"
            target="_blank" rel="noopener">${esc(tag)}</a>`
      : '—';
    const time = String(b.battle_datetime || '').slice(11, 16);
    return `<th class="clan-header">${link}<br><span class="elo-value">${esc(time)}</span></th>`;
  }).join('');

  const mapCells = battles.map((b) => {
    const win = b.winner_team === b.creator_team;
    return `<th class="${win ? 'win' : 'lose'}">
              <button type="button" class="map-link" data-battle-id="${encodeURIComponent(b.id)}"
                      title="Открыть бой">${esc(b.map_name)}</button>
            </th>`;
  }).join('');

  const sumHead = `<th>${summaryCell(battles)}</th>`;
  const avgHead = `<th>${avgLabel}</th>`;

  const rows = names.map((name, rowIndex) => {
    const cells = battles.map((_, i) => playerCell(type, players.get(name)[i])).join('');
    const avg = avgDataCell(type, name, grid);
    return `<tr style="--row-i:${Math.min(rowIndex, 12)}">
              <td>${esc(name)}</td>
              ${avgPosition === 'left' ? avg : ''}${cells}${avgPosition === 'right' ? avg : ''}
            </tr>`;
  }).join('');

  return `
    <table>
      <tr><th></th>${avgPosition === 'left' ? sumHead : ''}${clanCells}${avgPosition === 'right' ? sumHead : ''}</tr>
      <tr><th>Ник</th>${avgPosition === 'left' ? avgHead : ''}${mapCells}${avgPosition === 'right' ? avgHead : ''}</tr>
      ${rows}
    </table>`;
}
