/**
 * Barrel do módulo channels/whatsapp.
 * Imports devem usar `@/modules/channels/whatsapp` ao invés de subpaths.
 */
export * from './types';
export * from './jid';
export * from './client';
export * from './adapter';
export * from './webhook-parser';
export * from './media';
export { ensureOggDataUri, transcodeToOggOpus } from './audio-convert';
