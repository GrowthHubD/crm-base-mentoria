import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// Fase 0: config default do adaptador OpenNext pra Cloudflare Workers.
// Cache incremental (R2) e outros overrides entram em fases posteriores.
export default defineCloudflareConfig();
