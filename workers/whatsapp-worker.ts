import { loadEnvConfig } from "@next/env";

import { WhatsAppGatewayWorker } from "@/lib/whatsapp/worker";

loadEnvConfig(process.cwd());

async function main() {
  const worker = new WhatsAppGatewayWorker();

  const shutdown = () => {
    worker.stop();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await worker.start();
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
