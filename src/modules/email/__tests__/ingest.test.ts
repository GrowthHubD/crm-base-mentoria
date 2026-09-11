/**
 * O filtro que decide se um e-mail vira lead.
 *
 * Os dois erros aqui têm pesos MUITO diferentes: deixar passar uma newsletter
 * suja o funil e alguém apaga o card; barrar um remetente de verdade perde um
 * cliente em silêncio, e ninguém descobre. Por isso a bateria de baixo é
 * pesada nos nomes de pessoa que contêm pedaços das palavras da lista.
 */
import { describe, it, expect } from 'vitest';
import { pareceRobo, extrairNome, extrairEndereco } from '../ingest';

describe('pareceRobo', () => {
  it.each([
    'no-reply@empresa.com',
    'noreply@empresa.com',
    'NoReply@Empresa.com',
    'do-not-reply@banco.com.br',
    'donotreply@banco.com.br',
    'nao-responda@loja.com.br',
    'mailer-daemon@googlemail.com',
    'postmaster@dominio.com',
    'bounce@mkt.com',
    'notifications@github.com',
    'notificacao@nubank.com.br',
    'newsletter@jornal.com',
    'no-reply.suporte@empresa.com',
    'empresa_notificacoes@x.com',
    // Falso positivo conhecido e aceito: "news" isolado por ponto casa a
    // regra. Se um dia um cliente de verdade se chamar assim, o critério muda
    // para "palavra sozinha ou no começo do endereço" — não para lista maior.
    'joao.news@x.com',
    // O caso que furou em produção (transacional sem cabeçalho de massa).
    'welcome@supabase.com',
    'onboarding@resend.com',
    'billing@stripe.com',
  ])('barra %s', (e) => {
    expect(pareceRobo(e)).toBe(true);
  });

  it.each([
    'daviperesgomes0102@gmail.com',
    'acme6@agencia.com.br',
    'bruno@empresa.com',            // contém "no"
    'arnobot@empresa.com',          // contém "bot" colado, mas não é palavra
    'marcos.alerta@empresa.com',    // "alerta" != "alerts"
    'renovacao@cliente.com',        // contém "nova", não "news"
    'financeiro@fornecedor.com',
    'contato@empresa.com.br',
    'maria.silva@empresa.com',
  ])('deixa passar %s', (e) => {
    expect(pareceRobo(e)).toBe(false);
  });

  it('não quebra com endereço estranho', () => {
    expect(pareceRobo('')).toBe(false);
    expect(pareceRobo('@sodominio.com')).toBe(false);
  });
});

describe('extrairNome', () => {
  it('pega o nome de exibição', () => {
    expect(extrairNome('Davi Peres <davi@gmail.com>')).toBe('Davi Peres');
  });

  it('tira as aspas que o Gmail põe quando o nome tem vírgula', () => {
    expect(extrairNome('"Gomes, Davi" <davi@gmail.com>')).toBe('Gomes, Davi');
  });

  it('devolve null quando o cabeçalho é só o endereço', () => {
    // O chamador troca por o próprio endereço — melhor rótulo que "Sem nome".
    expect(extrairNome('davi@gmail.com')).toBeNull();
    expect(extrairNome('<davi@gmail.com>')).toBeNull();
  });
});

describe('extrairEndereco', () => {
  it('lê com e sem nome, sempre em minúscula', () => {
    expect(extrairEndereco('Davi <Davi@Gmail.com>')).toBe('davi@gmail.com');
    expect(extrairEndereco('  DAVI@GMAIL.COM ')).toBe('davi@gmail.com');
  });

  it('recusa o que não é endereço', () => {
    expect(extrairEndereco('sem arroba')).toBeNull();
    expect(extrairEndereco('a@b')).toBeNull();
  });
});
