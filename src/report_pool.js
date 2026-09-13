// Параллельный разбор реплеев: воркеры берут файлы из общей очереди. Если
// модульный воркер не запустился (старый браузер), этот поток очереди разбирает
// файлы в основном потоке — медленнее, но с тем же результатом.

const WORKER_URL = new URL('./report_worker.js?v=1', import.meta.url);

// Разбор держит в памяти весь поток пакетов реплея, поэтому воркеров немного.
const MAX_WORKERS = 4;

function startWorker() {
  if (typeof Worker !== 'function') return null;
  let worker;
  try {
    worker = new Worker(WORKER_URL, { type: 'module' });
  } catch {
    return null;
  }

  const lane = { worker, broken: false, pending: null };
  worker.onmessage = ({ data }) => {
    const resolve = lane.pending;
    lane.pending = null;
    resolve?.(data);
  };
  // Ошибка загрузки модуля может прийти ещё до первого файла — она запоминается.
  worker.onerror = (event) => {
    event.preventDefault();
    lane.broken = true;
    const resolve = lane.pending;
    lane.pending = null;
    resolve?.(null);
  };
  return lane;
}

/** Итог разбора воркером: { report } или { error }; null — воркер неработоспособен. */
async function buildInWorker(lane, file, tanksDb) {
  const buffer = await file.arrayBuffer();
  if (lane.broken) return null;
  return new Promise((resolve) => {
    lane.pending = resolve;
    lane.worker.postMessage({ name: file.name, buffer, tanksDb }, [buffer]);
  });
}

/**
 * Разбирает файлы и отдаёт каждый результат в onResult(file, report, error) по
 * мере готовности — порядок не гарантирован.
 */
export async function buildReports(files, { tanksDb, buildLocally, onResult }) {
  const queue = [...files];
  const cores = navigator.hardwareConcurrency || 2;
  const size = Math.max(1, Math.min(MAX_WORKERS, cores - 1, queue.length));

  const runLane = async () => {
    let lane = startWorker();
    for (let file = queue.shift(); file; file = queue.shift()) {
      let outcome = lane ? await buildInWorker(lane, file, tanksDb) : null;
      if (!outcome) {
        lane?.worker.terminate();
        lane = null;
        try {
          outcome = { report: await buildLocally(await file.arrayBuffer(), file.name) };
        } catch (err) {
          outcome = { error: err };
        }
      }
      await onResult(file, outcome.report ?? null, outcome.error ?? null);
    }
    lane?.worker.terminate();
  };

  await Promise.all(Array.from({ length: size }, runLane));
}
