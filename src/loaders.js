// Данные сайта, нужные разбору реплея: определения карт, таблицы разрушаемых
// объектов и распакованные игровые XML. Кэш свой у страницы и у каждого
// воркера: повторные бои на той же карте и технике файлы заново не качают.

const ROOT = new URL('../', import.meta.url);
const GAME_XML_PATH = /^[\w-]+(\/[\w-]+)*\.xml$/;

export function createLoaders() {
  const buffers = new Map();
  const load = (path) => {
    const url = new URL(path, ROOT).href;
    if (!buffers.has(url)) {
      buffers.set(url, fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .catch(() => null));
    }
    return buffers.get(url);
  };

  return {
    loadMapBuffer: (mapName) => (mapName
      ? load(`maps/definitions/${encodeURIComponent(mapName)}.xml`)
      : Promise.resolve(null)),
    // Номер объекта в квадрате карты → координаты.
    loadDestructiblesBuffer: (mapName) => (mapName
      ? load(`maps/destructibles/${encodeURIComponent(mapName)}.bin`)
      : Promise.resolve(null)),
    // Броня узлов и характеристики снарядов.
    loadGameXml: (path) => (GAME_XML_PATH.test(path) ? load(`vehicles/${path}`) : Promise.resolve(null)),
  };
}
