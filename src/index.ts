import { buildApp } from "./app.js";
import { config } from "./config.js";
import { startWebhookWorker } from "./worker/webhookWorker.js";

const app = await buildApp();

// See src/worker/webhookWorker.ts's doc comment for why this is started
// here (real server boot) rather than inside buildApp() (also used by
// every test via app.inject(), with no listening socket or real lifetime).
const webhookWorker = startWebhookWorker(app);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  webhookWorker.stop();
  await app.close();
  process.exit(0);
}
process.on("SIGTERM", (signal) => void shutdown(signal));
process.on("SIGINT", (signal) => void shutdown(signal));

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  webhookWorker.stop();
  process.exit(1);
}
