/**
 * Qual identidade visual este deploy veste.
 *
 * Mesmo desenho de `kanban-densidade.ts`: um build vai para os sete Workers,
 * então a marca é decidida no SERVIDOR por variável de ambiente e estampada
 * como `data-marca` no <html>. As cores em si moram em `globals.css`, num
 * bloco único por marca — aqui só se escolhe qual vale.
 *
 * O padrão é a Lidy: um deploy que esqueça a variável mostra a identidade que
 * os clientes já conheciam, nunca a de outro.
 */
const MARCAS = ['lidy', 'acme'] as const;
export type Marca = (typeof MARCAS)[number];

export function marcaDoDeploy(): Marca {
  const v = process.env.UI_MARCA?.trim().toLowerCase();
  return (MARCAS as readonly string[]).includes(v ?? '') ? (v as Marca) : 'lidy';
}

/** Nome, logo e tagline da marca — o que a sidebar veste. */
export function identidadeDaMarca(): { nome: string; logo: string; tagline: string } {
  if (marcaDoDeploy() === 'acme') {
    return { nome: 'Acme', logo: '/logo-acme.png', tagline: 'CRM de Prospecção' };
  }
  return { nome: 'Lidy', logo: '/logo.png', tagline: 'CRM de Atendimento' };
}
