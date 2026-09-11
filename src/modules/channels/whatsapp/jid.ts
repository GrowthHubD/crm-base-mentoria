/**
 * Helpers para JIDs e telefones do WhatsApp.
 *
 * JIDs do WhatsApp têm formato `5511999999999@s.whatsapp.net` (individual)
 * ou `5511999999999@g.us` (grupo). Telefones puros são só dígitos (DDI+DDD+número).
 */

/**
 * Remove tudo exceto dígitos. Use para preparar telefone antes de enviar
 * pra uazapi (que espera "5511999999999" sem máscara).
 */
export function normalizePhone(phone: string): string {
  return phone.replace(/[^0-9]/g, '');
}

/**
 * Extrai apenas os dígitos do telefone a partir de um JID ou phone formatado.
 * Aceita: "5511999999999@s.whatsapp.net", "+55 (11) 99999-9999", "5511999999999"
 */
export function extractPhone(jidOrPhone: string): string {
  return jidOrPhone.replace(/@.*$/, '').replace(/[^0-9]/g, '');
}

/**
 * Detecta se um JID é de grupo (`@g.us`).
 */
export function isGroupJid(jidOrPhone: string): boolean {
  return /@g\.us$/i.test(jidOrPhone);
}

/**
 * Converte phone para JID individual (`@s.whatsapp.net`).
 */
export function phoneToJid(phone: string): string {
  return `${normalizePhone(phone)}@s.whatsapp.net`;
}
