import 'dotenv/config';
import { buildApp } from './app';
import { loadEnv } from './config/env';

const env = loadEnv();

const app = await buildApp({
  env,
  startWorker: true,
  logger:
    env.NODE_ENV === 'production'
      ? true
      : { level: 'info', transport: { target: 'pino-pretty', options: { ignore: 'pid,hostname' } } },
});

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: env.PORT, host: '0.0.0.0' });
