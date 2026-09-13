export function escText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

export function escUrl(value) {
  const text = String(value ?? '');
  const safe = /[A-Za-z0-9/._\-~]/;
  let out = '';
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    if (byte < 128 && safe.test(ch)) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export function escJson(payload) {
  return JSON.stringify(payload)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');
}

function applyReplacements(template, replacements) {
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(placeholder, String(value));
  }
  return rendered;
}

const HIDE_IN_PAGE_NAV = `
<style>
  #hitsLinkBtn, #backLink { display: none !important; }
</style>
<script>

  history.replaceState = function () {};
  history.pushState = function () {};
<\/script>`;

export function applyResPrefix(rendered, resPrefix) {
  if (!resPrefix || resPrefix === '../') return rendered;
  const assets = ['maps/', 'icons/', 'MapElement/', 'backgrounds.png', 'favicon.svg', 'favicon.png'];
  let out = rendered;
  for (const asset of assets) out = out.replaceAll(`../${asset}`, resPrefix + asset);
  return out;
}

export function renderMapPage(view, { template, tokens, hitsViewerUrl = '', resPrefix = '../', hideInPageNav = false }) {
  const payload = escJson({
    map: view.map_display_name,
    players: view.players,
    positions: view.positions,
    deaths: view.deaths,
    damage_events: view.damage_events,
    markers: view.map_markers,
    my_team: view.my_team,
    winner_team: view.winner_team,
    finish_reason_code: view.finish_reason_code,
    team_health: view.team_health,
    duration_sec: view.duration_sec,
    capture_timeline: view.capture_timeline,
    min_time: view.min_time,
    map_marks: view.map_marks,
    reload_calls: view.reload_calls,
    destruction: view.destruction,
    first_spotted: view.first_spotted,
  });

  const rendered = applyReplacements(template, {
    '{{TOKENS}}': tokens,
    '{{MAP_NAME}}': escText(view.map_display_name),
    '{{BATTLE_DATE}}': escText(view.battle_date_display),
    '{{BATTLE_TIME}}': escText(view.battle_time),
    '{{GAME_VERSION}}': escText(view.game_version),
    '{{ALLY_CLAN}}': escText(view.my_clan),
    '{{ENEMY_CLAN}}': escText(view.enemy_clan),
    '{{DATA_PAYLOAD}}': payload,
    '{{IMG_SRC_LOW}}': view.map_img_low ? escUrl(`./maps/${view.map_img_low}`) : '',
    '{{IMG_SRC_HIGH}}': view.map_img_high ? escUrl(`./maps/${view.map_img_high}`) : '',
    '{{HITS_VIEWER_URL}}': escUrl(hitsViewerUrl),
  });
  return applyResPrefix(rendered, resPrefix) + (hideInPageNav ? HIDE_IN_PAGE_NAV : '');
}

export function renderHitsPage(view, { template, tokens, backToMapUrl = '', resPrefix = '../', hideInPageNav = false }) {
  const payload = escJson({
    shots: view.shots,
    armor: view.armor,
    wheels: view.wheels,
    battle_type: view.battle_type,
    my_team: view.my_team,
    ally_clan: view.ally_clan,
    enemy_clan: view.enemy_clan,
  });

  const rendered = applyReplacements(template, {
    '{{TOKENS}}': tokens,
    '{{MAP_NAME}}': escText(view.map_display_name),
    '{{BATTLE_DATE}}': escText(view.battle_date_display),
    '{{BATTLE_TIME}}': escText(view.battle_time_display),
    '{{DATA_PAYLOAD}}': payload,
    '{{BACK_TO_MAP_URL}}': escUrl(backToMapUrl),
  });
  return applyResPrefix(rendered, resPrefix) + (hideInPageNav ? HIDE_IN_PAGE_NAV : '');
}
