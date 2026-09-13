// Разрушаемые объекты карты: таблица «квадрат + номер объекта → координаты».
// Готовится заранее из скомпилированного пространства карты (maps/destructibles),
// потому что в реплее лежит только номер объекта внутри квадрата.

const MAGIC = 'MTD1';
const HEADER = 12;
const CHUNK_RECORD = 8;
const POINT_RECORD = 4;
const UNKNOWN = -32768;

/** Квадраты карты — по 100 метров, номер собирается из индексов сетки. */
export function chunkIdFromPosition(x, z) {
  const gx = Math.floor(x / 100);
  const gz = Math.floor(z / 100);
  if (gx < -127 || gx > 128 || gz < -127 || gz > 128) return null;
  return ((gx + 127) << 8) | (gz + 127);
}

/**
 * Разбирает файл таблицы. Возвращает функцию поиска: номер квадрата и номер
 * объекта в нём дают мировые координаты, либо null, если объекта нет в таблице.
 */
export function loadDestructibles(buffer) {
  if (!buffer || buffer.byteLength < HEADER) return null;

  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) return null;
  }

  const chunkCount = view.getUint16(6, true);
  const pointCount = view.getUint32(8, true);
  const pointsAt = HEADER + chunkCount * CHUNK_RECORD;
  if (pointsAt + pointCount * POINT_RECORD > buffer.byteLength) return null;

  const chunks = new Map();
  for (let i = 0; i < chunkCount; i++) {
    const at = HEADER + i * CHUNK_RECORD;
    chunks.set(view.getUint16(at, true), [view.getUint32(at + 2, true), view.getUint16(at + 6, true)]);
  }

  return (chunkId, index) => {
    const chunk = chunks.get(chunkId);
    if (!chunk || index < 0 || index >= chunk[1]) return null;

    const at = pointsAt + (chunk[0] + index) * POINT_RECORD;
    const dx = view.getInt16(at, true);
    const dz = view.getInt16(at + 2, true);
    if (dx === UNKNOWN && dz === UNKNOWN) return null;

    const cx = ((chunkId >> 8) - 127) * 100 + 50;
    const cz = ((chunkId & 255) - 127) * 100 + 50;
    return [cx + dx / 100, cz + dz / 100];
  };
}
