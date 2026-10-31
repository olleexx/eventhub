// Standalone worker: `npm run worker` (run as a second process/service on persistent hosts), or started
// in-process by server.js when RUN_WORKER_IN_PROCESS=true. NOT suitable for serverless: there, call
// POST /internal/cron/all from an external scheduler every minute instead.
import { pathToFileURL } from 'node:url';
import { TASKS, runTask } from './tasks.js';
import { log } from '../lib/logger.js';

export function startWorker() {
  const timers = [];
  const running = new Set();
  for (const [name, t] of Object.entries(TASKS)) {
    const tick = async () => {
      if (running.has(name)) return; // never overlap a task with itself
      running.add(name);
      try { await runTask(name); } finally { running.delete(name); }
    };
    setTimeout(tick, 2000 + Math.floor(Math.random() * 3000)); // stagger startup
    timers.push(setInterval(tick, t.everyMs));
  }
  log.info('worker_started', { tasks: Object.keys(TASKS) });
  return { stop: () => timers.forEach(clearInterval) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { // works on Windows too
  const w = startWorker();
  const stop = () => { w.stop(); setTimeout(() => process.exit(0), 500); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}