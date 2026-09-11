'use client';

/**
 * O quadro de colunas, do ponto de vista da tela do CRM.
 *
 * Concentra aqui o que estava espalhado na página: o estado das colunas, o
 * carregamento inicial e as quatro mutações que o board oferece (criar,
 * excluir, esconder/mostrar e reordenar).
 *
 * Duas decisões que valem o arquivo:
 *
 * **Otimista com volta atrás.** Arrastar uma coluna precisa responder no gesto,
 * senão a coluna anda meio segundo depois e o usuário arrasta de novo. Então o
 * estado muda na hora e, se o servidor recusar, volta exatamente ao que era e a
 * tela diz por quê. Nunca fica no meio do caminho.
 *
 * **A resposta do servidor manda.** As quatro rotas devolvem `{ stages }` já
 * atualizado, então cada mutação termina adotando essa lista em vez da versão
 * otimista. É o que corrige a posição quando o servidor renumera diferente do
 * que a tela previu, sem custar uma requisição a mais.
 *
 * Permissão não é decidida aqui: escrever em `pipeline_stages` é `requireAdmin`
 * no servidor. Este hook só empresta as ações; quem esconde os botões é a tela.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { STAGES_PADRAO, type StageColumn, type StageStatus } from '../types';
import { moverColuna, moverVizinho, definirVisibilidade, paraPut } from '../stage-order';

const ROTA = '/api/admin/pipeline-stages';

export interface NovaColuna {
  label: string;
  color: string;
  baseStatus: StageStatus;
}

async function pedir(init: RequestInit & { url?: string }): Promise<{ stages?: StageColumn[]; leadsMovidos?: number }> {
  const { url, ...resto } = init;
  const r = await fetch(url ?? ROTA, resto);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

export function useBoardColumns() {
  /**
   * Começa nos padrões e só troca quando a configuração chega: assim o quadro
   * desenha imediatamente, com a aparência de sempre, em vez de piscar vazio
   * esperando uma preferência visual. Se a chamada falhar, fica nos padrões —
   * ninguém perde o kanban porque a config não carregou.
   */
  const [stages, setStages] = useState<StageColumn[]>(STAGES_PADRAO);
  /**
   * A configuração de verdade já chegou?
   *
   * Enquanto não chegou, o que está na tela são os PADRÕES — nomes, cores e
   * ordem de fábrica, com ids sintéticos. Salvar a partir daí sobrescreveria o
   * funil real do cliente com o quadro genérico, e bastaria um arraste nos
   * primeiros instantes da tela. Por isso a edição só é liberada depois da
   * primeira resposta; se ela nunca vier, o quadro fica em leitura, que é o
   * lado seguro do erro.
   */
  const [pronto, setPronto] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  /**
   * Espelho do estado para as ações lerem sempre a versão mais recente.
   *
   * Sem ele, dois arrastes em sequência rápida partiriam os dois da mesma lista
   * (a que estava na closure), e o segundo desfaria o primeiro.
   */
  const atual = useRef(stages);
  useEffect(() => { atual.current = stages; }, [stages]);

  useEffect(() => {
    let vivo = true;
    fetch(ROTA, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!vivo || !j?.stages?.length) return;
        setStages(j.stages as StageColumn[]);
        setPronto(true);
      })
      .catch(() => {
        /* padrões seguem valendo, em leitura */
      });
    return () => { vivo = false; };
  }, []);

  const limparAviso = useCallback(() => { setErro(null); setAviso(null); }, []);

  /** Aplica na tela, manda o quadro inteiro e volta atrás se o servidor recusar. */
  const salvarQuadro = useCallback(async (proximas: StageColumn[]) => {
    const anteriores = atual.current;
    if (proximas === anteriores) return;

    setStages(proximas);
    atual.current = proximas;
    setSalvando(true);
    setErro(null);
    try {
      const j = await pedir({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stages: paraPut(proximas) }),
      });
      if (j.stages?.length) { setStages(j.stages); atual.current = j.stages; }
    } catch (e) {
      setStages(anteriores);
      atual.current = anteriores;
      setErro(e instanceof Error ? e.message : 'Não consegui salvar as colunas');
    } finally {
      setSalvando(false);
    }
  }, []);

  /** Soltou a coluna arrastada em cima de outra. */
  const mover = useCallback(
    (arrastadaId: string, alvoId: string) => salvarQuadro(moverColuna(atual.current, arrastadaId, alvoId)),
    [salvarQuadro]
  );

  /** Uma casa para a esquerda (-1) ou para a direita (1), pelas setas do menu. */
  const moverPasso = useCallback(
    (id: string, direcao: -1 | 1) => salvarQuadro(moverVizinho(atual.current, id, direcao)),
    [salvarQuadro]
  );

  const definirVisivel = useCallback(
    (id: string, visible: boolean) => salvarQuadro(definirVisibilidade(atual.current, id, visible)),
    [salvarQuadro]
  );

  const criar = useCallback(async (nova: NovaColuna) => {
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      const j = await pedir({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nova),
      });
      if (j.stages?.length) { setStages(j.stages); atual.current = j.stages; }
      return true;
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não consegui criar a coluna');
      return false;
    } finally {
      setSalvando(false);
    }
  }, []);

  /**
   * Remove uma coluna criada pelo cliente.
   *
   * O aviso conta quantos cards voltaram para a coluna de origem porque a
   * pergunta imediata de quem apaga uma coluna cheia é "e os meus leads?" — e o
   * servidor já devolve o número.
   */
  const excluir = useCallback(async (id: string) => {
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      const j = await pedir({ url: `${ROTA}?id=${encodeURIComponent(id)}`, method: 'DELETE' });
      if (j.stages?.length) { setStages(j.stages); atual.current = j.stages; }
      const n = j.leadsMovidos ?? 0;
      setAviso(
        n > 0
          ? `Coluna removida. ${n} ${n === 1 ? 'card voltou' : 'cards voltaram'} para a coluna de origem.`
          : 'Coluna removida.'
      );
      return true;
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não consegui remover a coluna');
      return false;
    } finally {
      setSalvando(false);
    }
  }, []);

  return { stages, pronto, salvando, erro, aviso, limparAviso, mover, moverPasso, definirVisivel, criar, excluir };
}

export type BoardColumns = ReturnType<typeof useBoardColumns>;
