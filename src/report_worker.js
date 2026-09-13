// Разбор одного реплея в отдельном потоке. Страница раздаёт файлы нескольким
// таким воркерам, и бои собираются параллельно, а не по одному.
import { createLoaders } from './loaders.js?v=1';
import { buildReport } from './report.js?v=7';

const loaders = createLoaders();

self.onmessage = async ({ data }) => {
  const { name, buffer, tanksDb } = data;
  try {
    const report = await buildReport(buffer, name, { tanksDb, ...loaders });
    self.postMessage({ report });
  } catch (err) {
    self.postMessage({ error: String(err?.message || err) });
  }
};
