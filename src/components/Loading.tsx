/**
 * Indicador de carregamento — três orbes girando.
 *
 * Substitui os "Carregando…" espalhados pela interface. Texto em espera não diz
 * nada que a ausência de conteúdo já não diga, e uma frase parada dá a sensação
 * de travamento: sem movimento, quem olha não sabe se o sistema está buscando
 * algo ou se morreu. O movimento contínuo é a informação.
 *
 * Não é barra de progresso de propósito: o CRM não sabe quanto falta (é uma
 * consulta remota, não um download), e uma barra que salta de 30% para 100%
 * mente mais do que informa.
 *
 * `label` existe para leitores de tela — a animação é muda para quem não a vê.
 */
export default function Loading({
  size = 'md',
  label = 'Carregando',
  className = '',
}: {
  /** `sm` cabe ao lado de um texto; `md` e `lg` para áreas vazias. */
  size?: 'sm' | 'md' | 'lg';
  label?: string;
  className?: string;
}) {
  const px = size === 'sm' ? 16 : size === 'lg' ? 40 : 26;
  const orbe = Math.max(3, Math.round(px * 0.2));

  return (
    <span
      className={`orbes ${className}`}
      style={{ width: px, height: px }}
      role="status"
      aria-label={label}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="orbe"
          style={{
            width: orbe,
            height: orbe,
            // Cada orbe entra num terço do ciclo — é o que dá a leitura de
            // rotação em vez de três pontos piscando juntos.
            animationDelay: `${i * -0.4}s`,
          }}
        />
      ))}
    </span>
  );
}

/**
 * Bloco centralizado, para quando a área inteira está vazia esperando dados.
 * Mantém a altura para o conteúdo não "pular" quando chegar.
 */
export function LoadingBlock({
  minHeight = 160,
  label = 'Carregando',
}: {
  minHeight?: number;
  label?: string;
}) {
  return (
    <div className="flex w-full items-center justify-center" style={{ minHeight }}>
      <Loading size="lg" label={label} />
    </div>
  );
}
