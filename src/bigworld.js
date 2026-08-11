export const PACKED_MAGIC = 0x62a14e45;

const PACKED_ELEMENT = 0;
const PACKED_STRING = 1;
const PACKED_INT = 2;
const PACKED_FLOAT = 3;
const PACKED_BOOL = 4;

const latin = new TextDecoder('utf-8');

export function decodePacked(bytes, view) {
  if (bytes.length < 5 || view.getUint32(0, true) !== PACKED_MAGIC) return null;

  const names = [];
  let cursor = 5;
  for (;;) {
    let end = cursor;
    while (end < bytes.length && bytes[end] !== 0) end++;
    if (end === cursor) return { names, rootAt: end + 1 };
    names.push(latin.decode(bytes.subarray(cursor, end)));
    cursor = end + 1;
  }
}

export function packedSection(view, names, start) {
  const count = view.getUint16(start, true);
  const ownEnd = view.getUint32(start + 2, true) & 0x0fffffff;
  const dataAt = start + 6 + count * 6;

  const entries = [];
  let offset = dataAt + ownEnd;
  for (let i = 0; i < count; i++) {
    const nameIndex = view.getUint16(start + 6 + i * 6, true);
    const descriptor = view.getUint32(start + 8 + i * 6, true);
    const end = dataAt + (descriptor & 0x0fffffff);
    entries.push({ name: names[nameIndex], type: descriptor >>> 28, start: offset, end });
    offset = end;
  }
  return entries;
}

export function packedValue(bytes, view, names, entry) {
  const { start, end, type } = entry;
  const length = end - start;

  if (type === PACKED_ELEMENT) return packedSection(view, names, start);
  if (type === PACKED_STRING) return latin.decode(bytes.subarray(start, end));
  if (type === PACKED_INT) {
    if (!length) return 0;

    let value = 0n;
    for (let i = length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[start + i]);
    if (bytes[end - 1] & 0x80) value -= 1n << BigInt(8 * length);
    return Number(value);
  }
  if (type === PACKED_FLOAT) {
    if (length < 4) return [];
    const floats = [];
    for (let i = 0; i + 4 <= length; i += 4) floats.push(view.getFloat32(start + i, true));
    return floats.length === 1 ? floats[0] : floats;
  }
  if (type === PACKED_BOOL) return length > 0 && bytes[start] !== 0;
  return null;
}

export function packedPick(bytes, view, names, section, name) {
  if (!Array.isArray(section)) return null;
  const entry = section.find((item) => item.name === name);
  return entry ? packedValue(bytes, view, names, entry) : null;
}

export function toPosition(value) {
  let numbers = [];

  if (typeof value === 'string') {
    for (const part of value.split(/\s+/)) {
      if (part === '') continue;
      const n = Number(part);
      if (!Number.isFinite(n)) return null;
      numbers.push(n);
    }
  } else if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === 'number')) return null;
    numbers = value.slice();
  } else {
    return null;
  }

  if (numbers.length === 2) return numbers;
  if (numbers.length >= 3) return [numbers[0], numbers[2]];
  return null;
}

function readTeamPositions(bytes, view, names, node, groupName) {
  const group = packedPick(bytes, view, names, node, groupName);
  if (!Array.isArray(group)) return {};

  const result = {};
  for (const teamTag of ['team1', 'team2']) {
    const team = packedPick(bytes, view, names, group, teamTag);
    if (!Array.isArray(team)) continue;
    const positions = [];
    for (const child of team) {
      if (!child.name.startsWith('position')) continue;
      const position = toPosition(packedValue(bytes, view, names, child));
      if (position) positions.push(position);
    }
    if (positions.length) result[teamTag] = positions;
  }
  return result;
}

function pickGameplay(bytes, view, names, root, gameplayId) {
  const types = packedPick(bytes, view, names, root, 'gameplayTypes');
  if (!Array.isArray(types)) return null;

  const preferred = gameplayId ? [gameplayId] : [];
  for (const name of preferred.concat(types.map((e) => e.name))) {
    const node = packedPick(bytes, view, names, types, name);
    if (!Array.isArray(node)) continue;
    const spawns = readTeamPositions(bytes, view, names, node, 'teamSpawnPoints');
    const bases = readTeamPositions(bytes, view, names, node, 'teamBasePositions');
    if (Object.keys(spawns).length || Object.keys(bases).length) return node;
  }
  return null;
}

export function loadMapXml(buffer, fileName, gameplayId = '') {
  if (!buffer) return null;

  try {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const decoded = decodePacked(bytes, view);
    if (decoded === null) {
      return { xml_parse_error: `${fileName}: не упакованный XML BigWorld` };
    }

    const { names, rootAt } = decoded;
    const root = packedSection(view, names, rootAt);

    const result = {
      bounding_box: { bottom_left: null, upper_right: null },
      team_spawn_points: {},
      team_base_positions: {},
    };

    const box = packedPick(bytes, view, names, root, 'boundingBox');
    if (Array.isArray(box)) {
      result.bounding_box.bottom_left = toPosition(packedPick(bytes, view, names, box, 'bottomLeft'));
      result.bounding_box.upper_right = toPosition(packedPick(bytes, view, names, box, 'upperRight'));
    }

    const node = pickGameplay(bytes, view, names, root, gameplayId);
    if (node !== null) {
      result.team_base_positions = readTeamPositions(bytes, view, names, node, 'teamBasePositions');

      const spawns = readTeamPositions(bytes, view, names, node, 'teamSpawnPoints');
      result.team_spawn_points = Object.fromEntries(
        Object.entries(spawns).map(([team, positions]) => [team, positions[0]]),
      );
    }

    return result;
  } catch (err) {
    return { xml_parse_error: `${fileName}: ${err.message}` };
  }
}
