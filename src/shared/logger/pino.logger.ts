import pino from 'pino';
import { env } from '../../config/env.js';

export function createLogger(stream?: pino.DestinationStream) {
  return pino(
    {
      level: env.LOG_LEVEL,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level(label) {
          return { level: label };
        },
      },
      redact: {
        paths: ['password', 'token', 'secret', 'authorization', 'cookie'],
        remove: true,
      },
    },
    stream
  );
}

export const logger = createLogger();
