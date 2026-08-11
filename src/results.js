import { escText } from './render.js?v=1';

const num = (v) => (v ?? 0).toLocaleString('ru');

function accuracyCell(s) {
  const shots = s.shots ?? 0;
  const hits = s.hits ?? 0;
  const pierce = s.piercings ?? 0;

  const clean = hits > 0 && hits === pierce;
  const perfect = clean && shots === hits;
  const cls = clean ? ' class="clean"' : '';
  return `<td class="accuracy" data-tip="выстрелов ${shots}, попаданий ${hits}, пробитий ${pierce}">`
    + `<span class="shots${perfect ? ' clean' : ''}">${shots}</span><span class="sl">/</span>`
    + `<span${cls}>${hits}</span><span class="sl">/</span><span${cls}>${pierce}</span></td>`;
}

function mmss(sec) {
  const m = Math.floor((sec || 0) / 60);
  return `${m}:${String((sec || 0) % 60).padStart(2, '0')}`;
}

function tankCell(player, resPrefix) {
  const name = player.tank_short_name || player.tank_type_no_nation || '';
  const type = player.tank_type_full || '';
  const icon = type
    ? `<img class="tank-icon" src="${resPrefix}icons/${escText(type.replace(':', '-'))}.png" alt=""
           loading="lazy" onerror="this.remove()">`
    : '';

  return `<td class="left tank"><span class="tank-cell"><span class="tank-slot">${icon}</span>`
    + `<span class="tank-name">${escText(name)}</span></span></td>`;
}

const COLUMNS = [
  {
    key: 'name', title: 'Игрок', align: 'left', width: '170px',
    render: (p) => `<td class="left name"><span>${escText(p.display_name)}</span></td>`,
  },

  { key: 'tank', title: 'Танк', align: 'left', width: '250px', render: tankCell, needsPrefix: true },
  { key: 'damage_dealt', title: 'Урон', width: '80px' },
  {
    key: 'assist_total', title: 'Ассист', width: '80px',
    render: (p) => {
      const s = p.final_stats || {};

      const parts = [
        ['Гусеница', s.assist_track], ['Разведданные', s.assist_radio],
        ['Оглушение', s.assist_stun], ['Дым', s.assist_smoke], ['Вдохновение', s.assist_inspire],
      ].filter(([, v]) => v > 0).map(([k, v]) => `${k}: ${num(v)}`);

      const tip = parts.length ? ` data-tip="${escText(parts.join(', '))}"` : '';
      return `<td${tip}>${num(s.assist_total)}</td>`;
    },
  },
  { key: 'damage_blocked', title: 'Заблок.', width: '80px' },
  {
    key: 'damage_received', title: 'Получено', width: '90px',
    render: (p) => {
      const s = p.final_stats || {};
      const hint = `попаданий по игроку ${s.hits_received ?? 0}, из них пробили ${s.piercings_received ?? 0}`
        + `; потенциальный урон ${num(s.potential_damage_received)}`
        + (s.damage_received_from_invisibles ? `; из инвиза ${num(s.damage_received_from_invisibles)}` : '');
      return `<td data-tip="${escText(hint)}">${num(s.damage_received)}</td>`;
    },
  },
  { key: 'kills', title: 'Фраги', width: '65px' },
  { key: 'accuracy', title: 'Реализация', width: '105px', render: (p) => accuracyCell(p.final_stats || {}) },
  { key: 'spotted', title: 'Засвет', width: '70px' },
  {
    key: 'life_time_sec', title: 'Время', width: '75px',
    render: (p) => {
      const s = p.final_stats || {};
      const km = ((s.mileage || 0) / 1000).toFixed(1);
      return `<td class="mono" data-tip="в бою ${mmss(s.life_time_sec)}, пройдено ${km} км">${mmss(s.life_time_sec)}</td>`;
    },
  },
  {
    key: 'xp', title: 'Опыт', width: '80px',
    render: (p) => {
      const s = p.final_stats || {};
      return `<td data-tip="серебро ${num(s.credits)}">${num(s.xp)}</td>`;
    },
  },
  {
    key: 'survived', title: 'HP', width: '75px',
    render: (p) => {
      const s = p.final_stats || {};
      if (s.is_destroyed) {

        return `<td class="dead" data-tip-plain data-tip="${escText(s.killed_by ? `уничтожил: ${s.killed_by}` : 'уничтожен')}">✗</td>`;
      }
      const left = s.health ?? 0;
      const max = p.max_hp || 0;
      return `<td class="alive" data-tip="осталось ${num(left)} из ${num(max)} HP">${num(left)}</td>`;
    },
  },
];

const COLGROUP = `<colgroup>${COLUMNS.map((c) => (c.width ? `<col style="width:${c.width}">` : '<col>')).join('')}</colgroup>`;

function playerRow(player, isOwner, resPrefix) {
  const s = player.final_stats || {};
  const cells = COLUMNS.map((c) => {
    if (!c.render) return `<td>${num(s[c.key])}</td>`;
    return c.needsPrefix ? c.render(player, resPrefix) : c.render(player);
  }).join('');
  return `<tr class="${isOwner ? 'owner' : ''}">${cells}</tr>`;
}

function teamBlock(title, clan, players, ownerLabel, side, resPrefix) {
  if (!players.length) return '';

  const sorted = [...players].sort(
    (a, b) => (b.final_stats?.damage_dealt || 0) - (a.final_stats?.damage_dealt || 0),
  );

  return `
    <section class="panel team ${side}">
      <header class="team-head">
        <h2>${escText(title)}</h2>
        ${clan ? `<span class="clan">${escText(clan)}</span>` : ''}
      </header>
      <div class="table-wrap">
        <table>
          ${COLGROUP}
          <thead><tr>${COLUMNS.map((c) => `<th class="${c.align === 'left' ? 'left' : ''}"><span>${c.title}</span></th>`).join('')}</tr></thead>
          <tbody>${sorted.map((p) => playerRow(p, p.display_name === ownerLabel, resPrefix)).join('')}</tbody>
        </table>
      </div>
    </section>`;
}

function finishReasonText(meta, allies, enemies) {
  const dead = (list) => list.filter((p) => p.final_stats?.is_destroyed).length;
  const won = meta.winner_team === meta.creator_team;

  switch (meta.finish_reason_code) {
    case 2:
      return won ? 'База противника захвачена' : 'Противник захватил базу';
    case 3:
      return 'Время боя истекло';
    case 1:
      if (enemies.length && dead(enemies) === enemies.length) return 'Вся техника противника уничтожена';
      if (allies.length && dead(allies) === allies.length) return 'Вся наша техника уничтожена';
      return 'Время боя истекло';
    default:
      return meta.finish_reason_name || '';
  }
}

export function renderResultsPage(report, { tokens = '', resPrefix = '../' } = {}) {
  const meta = report.meta;
  const ownTeam = meta.creator_team;
  const personal = meta.creator_personal_clan || '';
  const ownerLabel = personal ? `${meta.creator_name}[${personal}]` : String(meta.creator_name || '');

  const allies = report.players.filter((p) => p.team === ownTeam);
  const enemies = report.players.filter((p) => p.team !== ownTeam);

  const alliesLost = allies.filter((p) => p.final_stats?.is_destroyed).length;
  const enemiesLost = enemies.filter((p) => p.final_stats?.is_destroyed).length;
  const won = meta.winner_team === ownTeam;
  const draw = meta.winner_team === 0;
  const verdict = draw ? 'ничья' : won ? 'победа' : 'поражение';

  const minutes = Math.floor((meta.battle_duration_sec || 0) / 60);
  const seconds = String((meta.battle_duration_sec || 0) % 60).padStart(2, '0');

  const stamp = String(meta.battle_datetime || '');
  const battleDate = stamp.slice(0, 10);
  const battleTime = stamp.slice(11, 16);

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${escText(meta.map_name_ru || meta.map_name_tech || 'Итоги боя')} — итоги боя</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
${tokens}

* { box-sizing: border-box; }
body {
    margin: 0;
    padding: var(--space-5);
    font-family: var(--font-ui);
    color: var(--text);
    min-height: 100vh;
}
body::before {
    content: '';
    position: fixed;
    inset: 0;
    z-index: -1;
    background: url('${resPrefix}backgrounds.png') center / cover no-repeat, var(--color-bg);
    filter: brightness(var(--bg-brightness, 1));
    pointer-events: none;
}

.head {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    flex-wrap: wrap;
    padding: var(--space-4) var(--space-5);
    margin-bottom: var(--space-5);
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-xl);
    backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
    -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
    box-shadow: var(--glass-shadow);
}
.head h1 { font-size: 22px; margin: 0; font-weight: 700; letter-spacing: .2px; }
.head .meta { color: var(--text-secondary); font-size: 13px; }
.head .dot { color: var(--text-dim); }
.head .spacer { margin-left: auto; }
.head .reason { color: var(--text); }

.head .duration { font-family: var(--font-mono); display: inline-flex; align-items: center; gap: 6px; }
.head .clock-icon { width: 14px; height: 14px; opacity: .75; flex-shrink: 0; }

.score {
    font-family: var(--font-mono);
    font-size: 24px;
    font-weight: 600;
    letter-spacing: .5px;
}
.score .us { color: var(--team1); }
.score .them { color: var(--team2); }
.score .sep { color: var(--text-dim); margin: 0 6px; }

.verdict {
    padding: 5px 14px;
    border-radius: var(--radius-full);
    font-weight: 700;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: .6px;
}
.verdict.win  { color: var(--color-win);  background: var(--team1-dim); box-shadow: inset 0 0 0 1px var(--team1-mid); }
.verdict.lose { color: var(--color-lose); background: var(--team2-dim); box-shadow: inset 0 0 0 1px var(--team2-mid); }
.verdict.draw { color: var(--text-secondary); background: rgb(255 255 255 / 6%); }

.panel {
    background: var(--card-bg);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-xl);
    backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
    -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
    box-shadow: var(--glass-shadow);
    margin-bottom: var(--space-5);
    overflow: hidden;
}

.team-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--line);
}
.team-head h2 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .3px; }
.team.ally  .team-head h2 { color: var(--team1); }
.team.enemy .team-head h2 { color: var(--team2); }
.team-head .clan {
    font-family: var(--font-mono);
    font-size: 13px;
    padding: 3px 9px;
    border-radius: var(--radius-full);
    background: rgb(255 255 255 / 6%);
}
.team.ally  .team-head .clan { color: var(--team1); }
.team.enemy .team-head .clan { color: var(--team2); }
td.mono { font-family: var(--font-mono); }

.tank-cell { display: inline-flex; align-items: center; vertical-align: middle; min-width: 0; max-width: 100%; }
.tank-slot { flex: 0 0 90px; display: inline-flex; align-items: center; }
.tank-cell .tank-icon { max-width: 90px; opacity: .95; }
.tank-cell .tank-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
td .sub { color: var(--team2); font-size: 11px; margin-left: 3px; }
td[data-tip], [data-tip] { cursor: help; }

#tip {
    position: fixed;
    z-index: 100;
    max-width: 320px;
    padding: 8px 12px;
    font-family: var(--font-ui);
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--text);
    background: var(--glass-bg-strong);
    border: 1px solid var(--glass-border-strong);
    border-radius: var(--radius-md);
    backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
    -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
    box-shadow: var(--glass-shadow);
    pointer-events: none;
    opacity: 0;
    transform: translateY(4px);
    transition: opacity var(--duration-base) var(--ease-out),
                transform var(--duration-base) var(--ease-out);
}
#tip.show { opacity: 1; transform: translateY(0); }

#tip b { font-family: var(--font-mono); font-weight: 600; color: var(--color-accent); }

.table-wrap { overflow-x: clip; }
@media (max-width: 980px) {
    .table-wrap { overflow-x: auto; }
}

table {
    border-collapse: separate;
    border-spacing: 0;
    width: 100%;
    font-size: 13px;
    table-layout: fixed;
}
th, td {
    padding: 0 12px;

    text-align: center;
    white-space: nowrap;
    border-bottom: 1px solid var(--line);
    font-variant-numeric: tabular-nums;
}

tbody tr { height: 34px; }
th {
    padding-top: 8px;
    padding-bottom: 8px;
    color: var(--text-dim);
    font-weight: 500;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .5px;
}

th.left, td.left { text-align: left; font-variant-numeric: normal; }

th.left span { display: inline-block; text-align: center; }

td.name { font-weight: 500; }
td.name, td.dim { overflow: hidden; text-overflow: ellipsis; }
td.dim { color: var(--text-secondary); }

td.accuracy { font-family: var(--font-mono); white-space: nowrap; cursor: help; color: var(--text-secondary); }
td.accuracy .sl { color: var(--text-dim); margin: 0 2px; }
td.accuracy .shots { color: var(--text-dim); }
td.accuracy .clean { color: var(--team1); font-weight: 600; }

tbody tr:hover td { background: rgb(255 255 255 / 4%); }
tbody tr.owner td { background: rgb(var(--color-accent-rgb) / 10%); }
tbody tr.owner td:first-child {
    font-weight: 600;
    box-shadow: inset 3px 0 0 var(--color-accent);
}

tbody tr:last-child td { border-bottom: none; }
tbody tr:last-child td:first-child { border-bottom-left-radius:  calc(var(--radius-xl) - 1px); }
tbody tr:last-child td:last-child  { border-bottom-right-radius: calc(var(--radius-xl) - 1px); }
td.alive { color: var(--team1); font-weight: 700; }
td.dead  { color: var(--text-dim); cursor: help; }
</style>
</head>
<body>

<div class="head">
    <h1>${escText(meta.map_name_ru || meta.map_name_tech || '')}</h1>
    <span class="meta">${escText(battleDate)}</span>
    <span class="dot">·</span>
    <span class="meta">${escText(battleTime)}</span>

    <span class="spacer"></span>

    <span class="score">
        <span class="us">${enemiesLost}</span><span class="sep">:</span><span class="them">${alliesLost}</span>
    </span>
    <span class="verdict ${draw ? 'draw' : won ? 'win' : 'lose'}">${verdict}</span>
    <span class="meta reason">${escText(finishReasonText(meta, allies, enemies))}</span>
    <span class="meta duration" data-tip="длительность боя">
        <svg class="clock-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="6.6" stroke="currentColor" stroke-width="1.7"/>
            <path d="M8 4.4V8l2.6 1.9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>${minutes}:${seconds}</span>
</div>

${teamBlock('Союзники', meta.creator_clan, allies, ownerLabel, 'ally', resPrefix)}
${teamBlock('Противник', meta.enemy_clan, enemies, ownerLabel, 'enemy', resPrefix)}

<div id="tip" role="tooltip" aria-hidden="true"></div>

<script>

(function tooltips() {
    var tip = document.getElementById('tip');
    var GAP = 10;

    var DELAY = 1000;
    var timer = null;

    function show(target) {
        var text = target.getAttribute('data-tip');
        if (!text) return;
        var safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

        tip.innerHTML = target.hasAttribute('data-tip-plain') ? safe

            : safe.replace(/(\\d[\\d\\s]*)/g, '<b>$1</b>');
        tip.classList.add('show');

        var box = target.getBoundingClientRect();
        var size = tip.getBoundingClientRect();

        var top = box.top - size.height - GAP;
        if (top < GAP) top = box.bottom + GAP;
        var left = box.left + box.width / 2 - size.width / 2;

        left = Math.max(GAP, Math.min(left, window.innerWidth - size.width - GAP));
        tip.style.left = left + 'px';
        tip.style.top = top + 'px';
    }

    function hide() {
        clearTimeout(timer);
        tip.classList.remove('show');
    }

    document.addEventListener('mouseover', function (e) {
        var target = e.target.closest('[data-tip]');
        if (!target) return;
        clearTimeout(timer);
        timer = setTimeout(function () { show(target); }, DELAY);
    });
    document.addEventListener('mouseout', function (e) {
        if (e.target.closest('[data-tip]')) hide();
    });

    window.addEventListener('scroll', hide, true);
})();

(function fitTextColumns() {
    var COLUMNS_TO_FIT = [0, 1];
    var CELL_PADDING = 26;
    var tables = Array.prototype.slice.call(document.querySelectorAll('table'));

    function widestValue(table, index) {
        var widest = 0;
        Array.prototype.forEach.call(table.tBodies[0].rows, function (row) {
            var cell = row.cells[index];
            if (!cell) return;
            var probe = cell.firstElementChild || cell;
            widest = Math.max(widest, probe.getBoundingClientRect().width);
        });
        return widest;
    }

    COLUMNS_TO_FIT.forEach(function (index) {

        var shared = 0;
        tables.forEach(function (table) {
            shared = Math.max(shared, widestValue(table, index));
            var span = table.tHead.rows[0].cells[index].firstElementChild;
            if (span) shared = Math.max(shared, span.getBoundingClientRect().width);
        });
        if (!shared) return;

        tables.forEach(function (table) {
            var group = table.querySelector('colgroup');
            if (group && group.children[index]) {
                group.children[index].style.width = (Math.ceil(shared) + CELL_PADDING) + 'px';
            }

            var span = table.tHead.rows[0].cells[index].firstElementChild;
            if (!span) return;
            span.style.width = '';
            var own = Math.max(widestValue(table, index), span.getBoundingClientRect().width);
            span.style.width = Math.ceil(own) + 'px';
        });
    });
})();
<\/script>
</body>
</html>`;
}
