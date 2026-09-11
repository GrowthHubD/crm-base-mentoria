/**
 * Helpers de "rótulo de cargo" — usado pra montar a assinatura que vai pra
 * mensagem do WhatsApp e o nome exibido acima da bolha no CRM.
 *
 * Regras:
 *   attendant → "Atendente Carlos"
 *   admin     → "Gerente Carlos"
 *
 * Nome do user NÃO deve incluir o prefixo — quem cadastra registra só "Carlos",
 * o cargo é colado dinamicamente em runtime. Se o role mudar (atendente vira
 * gerente), as mensagens antigas passam a refletir o novo cargo
 * automaticamente — é o comportamento desejado.
 */
import type { UserRole } from '@/lib/auth-helpers';

export function rolePrefix(role: UserRole | null | undefined): string {
  if (role === 'admin') return 'Gerente';
  // Default ('attendant' explícito ou role faltando por algum motivo)
  return 'Atendente';
}

/** Monta "Atendente Carlos" / "Gerente Gabriel". */
export function formatSignedName(name: string, role: UserRole | null | undefined): string {
  return `${rolePrefix(role)} ${name}`;
}
