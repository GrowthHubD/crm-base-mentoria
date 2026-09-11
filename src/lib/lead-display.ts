/**
 * Helpers de exibição de lead — usados sempre que `name` pode estar vazio.
 *
 * Por que existe: lead criado por agendamento manual sem nome, ou inbound
 * cujo webhook não trouxe `pushName`, ficam com `name=null`. Mostrar "Sem nome"
 * polui a UI e dificulta identificar o cliente. Preferimos cair pro telefone
 * formatado como identificador visível.
 */

export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 13) return `+${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 9)}-${digits.slice(9)}`;
  if (digits.length === 12) return `+${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 8)}-${digits.slice(8)}`;
  return phone;
}

interface LeadLike {
  name?: string | null;
  phone?: string | null;
}

/**
 * Título principal pra exibir o lead. Ordem de preferência:
 *   1. `name` (se não-vazio depois de trim)
 *   2. `formatPhone(phone)`
 *   3. fallback genérico
 */
export function leadDisplayName(lead: LeadLike, fallback = 'Cliente sem nome'): string {
  const name = lead.name?.trim();
  if (name) return name;
  if (lead.phone) {
    const f = formatPhone(lead.phone);
    if (f) return f;
  }
  return fallback;
}

/**
 * Subtítulo pra exibir abaixo do título. Retorna string vazia quando
 * o título principal JÁ é o telefone (evita repetição).
 */
export function leadDisplaySubtitle(lead: LeadLike): string {
  if (lead.name?.trim() && lead.phone) return formatPhone(lead.phone);
  // Sem nome → título já é o contato; não duplica
  return '';
}

/**
 * Iniciais pro avatar. Se tem nome → primeira letra de nome+sobrenome.
 * Sem nome → últimos 2 dígitos do telefone.
 */
export function leadInitials(lead: LeadLike): string {
  const name = lead.name?.trim();
  if (name) {
    const parts = name.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  if (lead.phone) {
    const digits = lead.phone.replace(/\D/g, '');
    if (digits.length >= 2) return digits.slice(-2);
  }
  return '??';
}
