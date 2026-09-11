// Schema central — exporta todas as tabelas para Drizzle e better-auth
// Unidades (filiais de UM cliente). Precisa vir ANTES de quem referencia:
// leads, connections e users apontam para ela.
export * from './units';
export * from './users';
export * from './connections';
export * from './leads';
export * from './messages';
export * from './pipeline-config';
export * from './pipeline-stages';
export * from './email-accounts';
export * from './ai-agent-config';
export * from './scheduled-messages';
export * from './followups';
export * from './whatsapp-instances';
export * from './attendance-log';
// Faltava aqui: o drizzle-kit só cria o que passa pelo barrel, então a tabela
// nunca existiu no banco enquanto o código a consultava — o Ranking respondia
// 500 e nenhum "Converti!" era registrado.
export * from './attendant-close-log';
export * from './webhook-events';
export * from './shift-config';
export * from './automations';
export * from './quick-replies';
