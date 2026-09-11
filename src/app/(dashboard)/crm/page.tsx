'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import {
  MessageSquare, Clock, Flame, TriangleAlert, ChevronDown,
  Bot, UserRound, CheckCheck, RefreshCw, Settings, X, Save, ArrowRight, Loader2,
  Search, Filter as FilterIcon, Calendar, AlertCircle, Zap, CircleCheckBig, Columns3,
  Plus, UserPlus,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import Card from '@/components/Card';
import Toggle from '@/components/Toggle';
import type { KanbanLead, KanbanAttendant, ConversationSearchResult } from '@/modules/pipeline/queries';
import type { LeadStatus } from '@/modules/leads/types';
import { STAGES_PADRAO, type StageColumn } from '@/modules/pipeline/types';
import { colunasDaFaixa } from '@/modules/pipeline/stage-order';
import { useBoardColumns } from '@/modules/pipeline/hooks/useBoardColumns';
import ColumnMenu from '@/modules/pipeline/components/ColumnMenu';
import NewColumnButton from '@/modules/pipeline/components/NewColumnButton';
import { useCrmBoardData } from '@/modules/pipeline/hooks/useCrmBoardData';
import { useCrmSearch } from '@/modules/pipeline/hooks/useCrmSearch';
import type { QueuesResponse } from '@/modules/pipeline/crm-read-model';
import { donoDaAbaEmail } from '@/modules/pipeline/crm-read-model';
import { leadDisplayName, leadDisplaySubtitle, leadInitials } from '@/lib/lead-display';
import Loading from '@/components/Loading';
import { useAuthScope } from '@/modules/auth/client-scope';

const LeadModal = dynamic(() => import('@/components/crm/LeadModal'), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm">
      <Loading size="sm" label="Abrindo conversa" />
    </div>
  ),
});

const NewColumnPanel = dynamic(
  () => import('@/modules/pipeline/components/NewColumnPanel'),
  { ssr: false }
);

const CreateLeadModal = dynamic(
  () => import('@/modules/leads/components/CreateLeadModal'),
  { ssr: false }
);

/**
 * Em qual fila do quadro cada status aparece.
 *
 * `lost` fica de fora de propósito: perder um lead o tira do quadro em vez de
 * mandá-lo para outra coluna.
 */
const FILA_DO_STATUS: Partial<Record<LeadStatus, keyof QueuesResponse['queues']>> = {
  new: 'novos',
  priority: 'prioridade',
  urgency: 'urgencia',
  attending: 'respondidos',
  converted: 'convertidos',
};

/**
 * Aplica o movimento do card no estado local, do jeito que o servidor aplicaria.
 *
 * Serve ao movimento otimista: a tela responde ao arraste na hora e o próximo
 * poll confirma. Reproduz a ordenação do servidor — filas acionáveis em FIFO de
 * espera (entra no fim), arquivo com o mais recente no topo (entra no começo) —
 * para o card não pular de lugar quando a resposta real chegar.
 */
function moverNaFila(
  atual: QueuesResponse,
  leadId: string,
  novoStatus: LeadStatus,
  stageId: string | null
): QueuesResponse {
  const chaves = Object.keys(atual.queues) as (keyof QueuesResponse['queues'])[];

  let lead: KanbanLead | undefined;
  for (const k of chaves) {
    const achado = atual.queues[k].find((l) => l.id === leadId);
    if (achado) { lead = achado; break; }
  }
  // Card que não está no estado (busca aberta, poll no meio do caminho): deixa
  // o recarregamento resolver em vez de inventar um card do nada.
  if (!lead) return atual;

  const movido: KanbanLead = { ...lead, status: novoStatus, stageId };

  const queues = { ...atual.queues };
  for (const k of chaves) queues[k] = atual.queues[k].filter((l) => l.id !== leadId);

  const destino = FILA_DO_STATUS[novoStatus];
  if (destino) {
    const arquivo = destino === 'respondidos' || destino === 'convertidos';
    queues[destino] = arquivo ? [movido, ...queues[destino]] : [...queues[destino], movido];
  }

  return { ...atual, queues };
}

interface PipelineConfig {
  newToPriorityMinutes: number;
  priorityToUrgencyMinutes: number;
  autoEscalationEnabled: boolean;
  notifyOnEscalation: boolean;
}

/**
 * Tipo do `dataTransfer` quando o que está sendo arrastado é uma COLUNA.
 *
 * Precisa ser um tipo próprio, e não um campo dentro do arraste de card: é por
 * ele que a coluna de destino descobre, ainda no `dragover`, se deve se
 * preparar para receber um card ou para trocar de lugar.
 */
const TIPO_ARRASTE_COLUNA = 'application/x-stage-id';
const CARDS_POR_LOTE = 60;

// Paleta única do funil (textos/badges opacos)
const TONE = {
  info: { text: '#00d492', bg: 'rgba(0,212,146,0.10)', border: 'rgba(0,212,146,0.28)', glow: 'rgba(0,212,146,0.45)' },
  warn: { text: '#d99d00', bg: 'rgba(217,157,0,0.10)', border: 'rgba(217,157,0,0.28)', glow: 'rgba(217,157,0,0.45)' },
  err:  { text: '#ff6060', bg: 'rgba(255,96,96,0.10)', border: 'rgba(255,96,96,0.28)', glow: 'rgba(255,96,96,0.45)' },
} as const;

type Tone = keyof typeof TONE;

/** Forma de um tom, para aceitar tanto os fixos quanto os derivados de config. */
type ToneShape = { text: string; bg: string; border: string; glow: string };

/**
 * Deriva a paleta de uma coluna a partir da cor escolhida pelo cliente.
 *
 * As opacidades são as mesmas do `TONE` fixo (0.10 no fundo, 0.28 na borda,
 * 0.45 no brilho) — assim uma coluna personalizada tem exatamente o peso
 * visual das originais, em vez de destoar do resto do quadro.
 */
function toneFromHex(hex: string): ToneShape {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  // Cor inválida cai no cinza neutro em vez de quebrar o estilo da coluna.
  const [r, g, b] = m
    ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16))
    : [139, 139, 148];
  return {
    text: `rgb(${r},${g},${b})`,
    bg: `rgba(${r},${g},${b},0.10)`,
    border: `rgba(${r},${g},${b},0.28)`,
    glow: `rgba(${r},${g},${b},0.45)`,
  };
}

// A forma da coluna e os padrões do quadro vivem em `modules/pipeline/types` —
// o board, o menu de coluna e o botão de criar precisam da MESMA definição, e
// duplicá-la aqui foi o que deixou a tela sem os dois campos de escalação.

// Espelho do isAllowedManualTransition do backend (modules/leads/service.ts).
// Mantém UI e backend sincronizados.
function allowedManualTargets(from: LeadStatus): LeadStatus[] {
  if (from === 'converted' || from === 'lost') return [];
  const targets: LeadStatus[] = [];
  // priority é só permitido vindo de new ou attending
  if (from === 'new' || from === 'attending') targets.push('priority');
  // urgency permitido de new, priority, attending
  if (from === 'new' || from === 'priority' || from === 'attending') targets.push('urgency');
  // attending sempre permitido (atendente assume)
  if (from !== 'attending') targets.push('attending');
  // terminais sempre permitidos como destino
  targets.push('converted', 'lost');
  return targets;
}

const STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'Novo',
  priority: 'Prioridade',
  urgency: 'Urgência',
  attending: 'Atendendo',
  converted: 'Convertido',
  lost: 'Perdido',
};

type QueueCategory = 'novos' | 'prioridade' | 'urgencia' | 'respondidos';

const CATEGORY_LABEL: Record<QueueCategory, string> = {
  novos: 'Novos',
  prioridade: 'Prioridade',
  urgencia: 'Urgência',
  respondidos: 'Respondidos',
};

const ALL_CATEGORIES: QueueCategory[] = ['novos', 'prioridade', 'urgencia', 'respondidos'];

interface Filters {
  name: string;
  fromDate: string;  // YYYY-MM-DDTHH:mm
  toDate: string;
  categories: Set<QueueCategory>;
}

function emptyFilters(): Filters {
  return {
    name: '',
    fromDate: '',
    toDate: '',
    categories: new Set(ALL_CATEGORIES),
  };
}

function filterCards(cards: KanbanLead[], f: Filters): KanbanLead[] {
  const name = f.name.trim().toLowerCase();
  const from = f.fromDate ? new Date(f.fromDate).getTime() : null;
  const to = f.toDate ? new Date(f.toDate).getTime() : null;
  return cards.filter(l => {
    if (name && !(l.name ?? '').toLowerCase().includes(name) && !(l.phone ?? '').toLowerCase().includes(name)) return false;
    const ts = (l.lastMessageAt ? new Date(l.lastMessageAt).getTime() : new Date(l.createdAt).getTime());
    if (from !== null && ts < from) return false;
    if (to !== null && ts > to) return false;
    return true;
  });
}

export default function CRMQueuesPage() {
  const { role, veTudo, kanbanManual } = useAuthScope();
  // Canal do CRM, escolhido na sidebar (CRM → WhatsApp | E-mail). Cada canal
  // abre o MESMO kanban, mas com as abas e os cards só daquele canal. Default
  // WhatsApp quando a URL não diz — é o canal principal da operação.
  const searchParams = useSearchParams();
  const canal: 'whatsapp' | 'email' = searchParams.get('canal') === 'email' ? 'email' : 'whatsapp';
  // Aba ativa: no WhatsApp começa em "Todas as conexões"; no e-mail em "Todas
  // as caixas". `email` (sem dono) = todas as caixas; `email:<userId>` = uma.
  const [activeConn, setActiveConn] = useState<string>(canal === 'email' ? 'email' : 'all');

  // Trocar de canal reseta a aba para o default daquele canal — senão um
  // connectionId de WhatsApp sobreviveria à ida para o e-mail (e vice-versa),
  // deixando a tela vazia sem explicação.
  useEffect(() => {
    setActiveConn(canal === 'email' ? 'email' : 'all');
  }, [canal]);
  const {
    data,
    setData,
    error,
    loading,
    refreshing,
    reload,
    beginMutation,
  } = useCrmBoardData(activeConn);
  const [configOpen, setConfigOpen] = useState(false);
  const [openLead, setOpenLead] = useState<string | null>(null);
  const [createLeadStage, setCreateLeadStage] = useState<StageColumn | null>(null);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Painel de nova coluna, irmão do de filtros: mesma barra, mesmo lugar de
  // abertura, mesma pele. O estado mora aqui pelo mesmo motivo do `filtersOpen`
  // — quem desenha o painel é a página, o componente é só o gatilho.
  const [novaColunaOpen, setNovaColunaOpen] = useState(false);
  const searchTerm = filters.name.trim();
  const {
    active: searchActive,
    loading: searchLoading,
    results: searchResults,
  } = useCrmSearch(activeConn, searchTerm);

  /**
   * Pan do quadro: segurar o mouse num espaço vazio e arrastar percorre as
   * colunas, sem caçar a barra de rolagem — com quinze colunas, a barra fica
   * longe de onde o olho está. Convive com o arraste de CARD porque só arma
   * quando o clique NÃO nasce num elemento arrastável ou interativo: o card
   * continua com o drag-and-drop nativo, o fundo vira "mão".
   *
   * Só mouse (`pointerType`): no toque o navegador já rola a faixa nativamente,
   * e capturar o dedo quebraria isso.
   */
  const faixaRef = useRef<HTMLDivElement | null>(null);
  const pan = useRef<{ x: number; scroll: number } | null>(null);
  const [panning, setPanning] = useState(false);

  function panInicia(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const alvo = e.target as HTMLElement;
    // Card (draggable), botão, link, campo: cada um já tem o próprio gesto.
    if (alvo.closest('[draggable="true"], button, a, input, textarea, select')) return;
    const el = faixaRef.current;
    if (!el) return;
    pan.current = { x: e.clientX, scroll: el.scrollLeft };
    el.setPointerCapture(e.pointerId);
  }

  function panMove(e: React.PointerEvent<HTMLDivElement>) {
    const p = pan.current;
    const el = faixaRef.current;
    if (!p || !el) return;
    const dx = e.clientX - p.x;
    // O cursor de "agarrando" só entra com movimento de verdade — um clique
    // parado num espaço vazio não deve piscar o cursor.
    if (!panning && Math.abs(dx) > 4) setPanning(true);
    el.scrollLeft = p.scroll - dx;
  }

  function panFim(e: React.PointerEvent<HTMLDivElement>) {
    if (!pan.current) return;
    pan.current = null;
    setPanning(false);
    faixaRef.current?.releasePointerCapture?.(e.pointerId);
  }

  /**
   * Move o card.
   *
   * O `stageId` acompanha o status, nunca o substitui: soltar o card numa
   * coluna personalizada grava a coluna E o status âncora dela, para escalação,
   * SLA e relatórios seguirem operando sobre um estado conhecido. `null`
   * devolve o card à coluna de fábrica do status.
   */
  async function handleMoveLead(
    leadId: string,
    newStatus: LeadStatus,
    stageId: string | null = null
  ) {
    // O card muda de coluna ANTES da ida ao servidor. Antes, o atendente
    // soltava o card e ele voltava para o lugar de origem até o PATCH e o
    // recarregamento inteiro do quadro terminarem — dois round-trips de tela
    // parada, que era o "delay" de que o cliente reclamou. O servidor continua
    // sendo a verdade: se o PATCH falhar, o estado anterior volta.
    if (!data) return;
    const anterior = data;
    beginMutation();
    setData((atual) => moverNaFila(atual, leadId, newStatus, stageId));

    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus, stageId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setData(() => anterior);
        alert(`Erro: ${j.error ?? res.status}`);
        return;
      }
      void reload(true);
    } catch (err) {
      setData(() => anterior);
      alert(err instanceof Error ? err.message : 'Erro');
    }
  }

  const rawQueues = data?.queues ?? { novos: [], prioridade: [], urgencia: [], respondidos: [], convertidos: [] };
  const connections = data?.connections ?? [];

  /**
   * Nome, cor, ordem e visibilidade das colunas, mais as ações que as mudam.
   *
   * Estado e mutações vivem no módulo do funil (`useBoardColumns`): esta tela
   * já tem 2 mil linhas, e a regra de reordenar precisa de teste sem navegador.
   */
  const colunas = useBoardColumns();
  const stages = colunas.stages;

  /**
   * Pode mexer nas COLUNAS (criar, esconder, apagar, reordenar)?
   *
   * Gate por papel, e não por `veTudo`: com `FEATURE_LEAD_OWNERSHIP` desligado
   * — que é o caso dos clientes de atendimento — `veTudo` é verdadeiro para
   * todo mundo, e os controles apareceriam para quem toma 403 no servidor.
   * Escrever em `pipeline_stages` é `requireAdmin`, então o espelho aqui é o
   * papel. A porta continua sendo a rota; isto só evita oferecer o que não vai.
   */
  const ehAdmin = role === 'admin';
  // Só depois que a configuração real chegou — ver `pronto` em useBoardColumns.
  const podeEditarColunas = ehAdmin && colunas.pronto;

  /** A coluna de FÁBRICA de um status — as personalizadas são resolvidas por id. */
  const stageDe = useMemo(() => {
    const mapa = new Map(stages.filter((s) => !s.isCustom).map((s) => [s.status, s]));
    return (status: StageColumn['status']): StageColumn =>
      mapa.get(status) ?? STAGES_PADRAO.find((s) => s.status === status)!;
  }, [stages]);

  /**
   * Colunas do grid superior: as três de fila mais TODAS as personalizadas.
   *
   * As personalizadas entram aqui qualquer que seja o status âncora — são
   * colunas de trabalho, onde o atendente larga o card. Respondidos e
   * Convertidos seguem sendo listas de leitura, embaixo.
   *
   * A projeção mora em `stage-order` porque as setas do menu precisam dela
   * para saber quem é o vizinho VISÍVEL de cada coluna.
   */
  const colunasTopo = useMemo(() => colunasDaFaixa(stages), [stages]);

  const queues = useMemo(() => {
    // Aba "E-mail": recorte por CANAL. Os leads de e-mail não têm conexão de
    // WhatsApp, então o filtro por conexão os excluía e eles só apareciam em
    // "Todas". Aqui a aba de e-mail mostra só eles; as abas de conexão já vêm
    // sem e-mail do servidor.
    const donoEmail = donoDaAbaEmail(activeConn);
    const porCanal = (cards: KanbanLead[]) => {
      if (canal === 'email') {
        // Só e-mail; se uma caixa está selecionada, só os leads dela.
        return donoEmail
          ? cards.filter((l) => l.channel === 'email' && l.ownerId === donoEmail)
          : cards.filter((l) => l.channel === 'email');
      }
      // Canal WhatsApp: fora o e-mail. A aba de conexão já vem filtrada do
      // servidor; "Todas as conexões" agrega os números, sem e-mail no meio.
      return cards.filter((l) => l.channel !== 'email');
    };
    return {
      novos: filters.categories.has('novos') ? porCanal(filterCards(rawQueues.novos, filters)) : [],
      prioridade: filters.categories.has('prioridade') ? porCanal(filterCards(rawQueues.prioridade, filters)) : [],
      urgencia: filters.categories.has('urgencia') ? porCanal(filterCards(rawQueues.urgencia, filters)) : [],
      respondidos: filters.categories.has('respondidos') ? porCanal(filterCards(rawQueues.respondidos, filters)) : [],
      convertidos: porCanal(filterCards(rawQueues.convertidos ?? [], filters)),
    };
  }, [rawQueues, filters, activeConn, canal]);

  /**
   * Cards de uma coluna.
   *
   * Personalizada leva os cards que apontam para ela (`stageId`); de fábrica
   * leva os do seu status que NÃO estão em nenhuma personalizada. Sem esse
   * segundo filtro o mesmo lead apareceria duas vezes no quadro — na coluna
   * criada e na de origem.
   */
  const cardsDa = useMemo(() => {
    const porStatus: Record<string, KanbanLead[]> = {
      new: queues.novos,
      priority: queues.prioridade,
      urgency: queues.urgencia,
      attending: queues.respondidos,
      converted: queues.convertidos,
    };
    const todos = [
      ...queues.novos, ...queues.prioridade, ...queues.urgencia,
      ...queues.respondidos, ...queues.convertidos,
    ];

    /**
     * Onde cai um card SEM coluna própria (`stageId` nulo).
     *
     * Normalmente é a coluna de fábrica do status dele. Mas quando o cliente
     * monta um funil próprio e ESCONDE as de fábrica, essa coluna não está na
     * tela — e o card sumiria: continuaria no banco, com status certo, invisível
     * para quem atende. Um lead novo que ninguém vê é pior que um bug de tela.
     *
     * Então o card cai na primeira coluna VISÍVEL ancorada no mesmo status. Se
     * não houver nenhuma, na primeira visível do quadro — em último caso ele
     * aparece no lugar errado, o que ainda é melhor do que não aparecer.
     */
    const visiveis = stages.filter((x) => x.visible).sort((a, b) => a.position - b.position);
    const acolhe = (status: string): string | null => {
      const doStatus = visiveis.find((x) => x.status === status);
      return (doStatus ?? visiveis[0])?.id ?? null;
    };

    return (s: StageColumn): KanbanLead[] => {
      if (s.isCustom) return todos.filter((l) => l.stageId === s.id);

      const meus = (porStatus[s.status] ?? []).filter((l) => !l.stageId);
      // Esta coluna é o destino dos órfãos do próprio status?
      const souOAcolhedor = acolhe(s.status) === s.id;
      const orfaos = souOAcolhedor
        ? Object.entries(porStatus)
            .filter(([st]) => st !== s.status && acolhe(st) === s.id)
            .flatMap(([, lista]) => lista.filter((l) => !l.stageId))
        : [];
      return [...meus, ...orfaos];
    };
  }, [queues, stages]);

  // Resultados da busca respeitam o intervalo de data (De/Até) do mesmo painel,
  // aplicado no client (já temos lastMessageAt em cada resultado).
  const visibleResults = useMemo(() => {
    if (!searchResults) return [];
    const from = filters.fromDate ? new Date(filters.fromDate).getTime() : null;
    const to = filters.toDate ? new Date(filters.toDate).getTime() : null;
    if (from === null && to === null) return searchResults;
    return searchResults.filter((r) => {
      const ts = r.lastMessageAt ? new Date(r.lastMessageAt).getTime() : new Date(r.createdAt).getTime();
      if (from !== null && ts < from) return false;
      if (to !== null && ts > to) return false;
      return true;
    });
  }, [searchResults, filters.fromDate, filters.toDate]);

  const filterActive =
    filters.name.trim() !== '' ||
    filters.fromDate !== '' ||
    filters.toDate !== '' ||
    filters.categories.size !== ALL_CATEGORIES.length;

  const iaCountNovos = queues.novos.filter(l => l.aiAgentActive).length;
  const iaCountPrio = queues.prioridade.filter(l => l.aiAgentActive).length;
  const attCountPrio = queues.prioridade.filter(l => l.assignedToId).length;
  const attCountUrg = queues.urgencia.filter(l => l.assignedToId).length;

  return (
    <div className="flex flex-col">
      <PageHeader
        icon={<MessageSquare size={18} strokeWidth={1.6} />}
        title="CRM — Filas de Atendimento"
        subtitle="Distribuição inteligente de conversas em tempo real"
        right={
          <div className="flex items-center gap-3">
            {/* Configurar coluna muda o quadro do time inteiro — é decisão de
                dono. Quem tem carteira própria nem vê o botão. */}
            {veTudo && (
              <button
                onClick={() => setConfigOpen(true)}
                title="Configurações de fila"
                aria-label="Configurações"
                className="flex h-8 w-8 items-center justify-center rounded-lg border text-text-muted transition hover:bg-[rgba(var(--accent-light-rgb),0.08)] hover:text-blue-light"
                style={{ borderColor: 'var(--border-subtle)' }}
              >
                <Settings size={14} strokeWidth={1.6} />
              </button>
            )}
            <button
              type="button"
              aria-label="Criar novo lead"
              title="Criar novo lead"
              onClick={() => {
                const destination = colunasTopo.find((stage) => stage.status !== 'converted');
                if (destination) setCreateLeadStage(destination);
              }}
              disabled={!colunasTopo.some((stage) => stage.status !== 'converted')}
              className="btn-primary h-8 px-3 text-[11.5px] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <UserPlus size={14} strokeWidth={1.8} />
              <span className="hidden sm:inline">Novo lead</span>
            </button>
            <button
              onClick={() => void reload(true)}
              aria-label="Atualizar"
              className="flex h-8 w-8 items-center justify-center rounded-lg border text-text-muted hover:text-text-secondary"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              <RefreshCw size={14} strokeWidth={1.6} className={refreshing ? 'animate-spin' : ''} />
            </button>
          </div>
        }
      />

      <div className="px-3 py-4 md:px-6 md:py-6">
        <div className="mb-4 flex items-stretch gap-2 md:gap-3">
          {/* Tabs de conexão: scroll-x próprio, não engole o botão de filtros */}
          <div
            className="flex flex-1 items-center gap-1 overflow-x-auto rounded-xl border p-1.5"
            style={{ background: '#111116', borderColor: 'var(--border-subtle)' }}
          >
            {canal === 'whatsapp' ? (
              <>
                {/* "Todas" agrega todas as conexões de WhatsApp. Sem esse
                    agregado, com várias conexões algumas conversas sumiriam. */}
                <FilterTab active={activeConn === 'all'} onClick={() => setActiveConn('all')}>
                  Todas as conexões
                </FilterTab>
                {connections.map(c => (
                  <FilterTab
                    key={c.id}
                    active={activeConn === c.id}
                    onClick={() => setActiveConn(c.id)}
                  >
                    {c.name ?? c.id.slice(0, 8)}
                  </FilterTab>
                ))}
              </>
            ) : (
              <>
                {/* Canal E-mail: "Todas as caixas" + uma aba por caixa conectada.
                    E-mail não tem conexão; a ligação com a caixa é o dono, então
                    cada aba filtra canal + dono no cliente. */}
                <FilterTab active={activeConn === 'email'} onClick={() => setActiveConn('email')}>
                  Todas as caixas
                </FilterTab>
                {(data?.emailAccounts ?? []).map((a) => (
                  <FilterTab
                    key={a.id}
                    active={activeConn === `email:${a.userId}`}
                    onClick={() => setActiveConn(`email:${a.userId}`)}
                  >
                    {`✉ ${a.email}`}
                  </FilterTab>
                ))}
              </>
            )}
          </div>

          {/* Bloco de filtros: container separado, sempre visível na direita */}
          <div className="flex shrink-0 items-center gap-2">
            {/* Criar coluna fica AQUI, e não no fim da faixa: num funil de
                quinze etapas o fim da faixa está a três telas de rolagem à
                direita, e a ação sumiria justo para quem tem mais colunas.
                Abre um painel abaixo da barra, do mesmo jeito que os Filtros. */}
            {podeEditarColunas && (
              <NewColumnButton
                aberto={novaColunaOpen}
                onToggle={() => setNovaColunaOpen((v) => !v)}
                ocultas={stages.filter((s) => !s.visible).length}
              />
            )}
            <button
              onClick={() => setFiltersOpen(v => !v)}
              className={`inline-flex h-full items-center gap-1.5 rounded-xl px-3 text-[12px] transition ${
                filtersOpen || filterActive ? 'text-white' : 'text-text-muted hover:text-text-secondary'
              }`}
              style={
                filtersOpen || filterActive
                  ? { background: 'var(--accent-deep)', border: '1px solid rgba(var(--accent-light-rgb),0.4)' }
                  : { background: '#111116', border: '1px solid var(--border-subtle)' }
              }
            >
              <FilterIcon size={13} strokeWidth={1.7} />
              Filtros
              {filterActive && (
                <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9.5px] font-bold"
                  style={{ background: 'var(--accent-light)', color: '#0D0D12' }}>
                  on
                </span>
              )}
            </button>
            {filterActive && (
              <button
                onClick={() => setFilters(emptyFilters())}
                className="text-[11px] text-text-muted hover:text-text-secondary"
                title="Limpar filtros"
              >
                limpar
              </button>
            )}
          </div>
        </div>

        {podeEditarColunas && novaColunaOpen && (
          <NewColumnPanel
            stages={stages}
            ocupado={colunas.salvando}
            onCriar={colunas.criar}
            onMostrar={(id) => colunas.definirVisivel(id, true)}
            onFechar={() => setNovaColunaOpen(false)}
          />
        )}

        {filtersOpen && (
          <FiltersPanel mostrarCategorias={!kanbanManual} filters={filters} onChange={setFilters} />
        )}

        {loading && !data && (
          <div className="rounded-xl border border-dashed p-10 text-center text-[12.5px] text-text-muted"
            style={{ borderColor: 'var(--border-subtle)' }}>
            <Loading size="sm" label="Carregando filas" />
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-xl border p-3 text-[12px]"
            style={{ background: 'rgba(248,113,113,0.08)', borderColor: 'rgba(248,113,113,0.3)', color: '#F87171' }}>
            Erro ao carregar: {error}. Tentando novamente em alguns segundos…
          </div>
        )}

        {/* Resultado da última mexida nas colunas. Fica aqui, e não dentro do
            menu, porque a mensagem sobrevive ao menu fechar — é onde cabe
            dizer quantos cards voltaram para a coluna de origem. */}
        {(colunas.erro || colunas.aviso) && (
          <div
            className="mb-3 flex items-start justify-between gap-3 rounded-xl border p-3 text-[12px]"
            style={
              colunas.erro
                ? { background: 'rgba(248,113,113,0.08)', borderColor: 'rgba(248,113,113,0.3)', color: '#F87171' }
                : { background: 'rgba(34,197,94,0.07)', borderColor: 'rgba(34,197,94,0.3)', color: '#22C55E' }
            }
          >
            <span>{colunas.erro ?? colunas.aviso}</span>
            <button onClick={colunas.limparAviso} aria-label="Fechar aviso" className="shrink-0 opacity-70 hover:opacity-100">
              <X size={13} strokeWidth={2} />
            </button>
          </div>
        )}

        {searchActive && (
          <SearchResultsView
            term={searchTerm}
            loading={searchLoading}
            results={visibleResults}
            onOpen={setOpenLead}
            onClear={() => setFilters({ ...filters, name: '' })}
          />
        )}

        {data && !searchActive && (
          <>
            {/* Colunas de largura FIXA com rolagem horizontal, em toda tela.

                Antes era `lg:grid-cols-3` no desktop — três colunas esticadas
                para ocupar o viewport. Isso tinha dois problemas: as colunas
                ficavam largas demais (pouca informação por tela, muito scroll
                vertical) e, com colunas configuráveis, um funil de seis ou dez
                simplesmente não cabia — o grid de 3 espremia tudo.

                Largura fixa + rolagem é como todo CRM de funil se comporta:
                quantas colunas o cliente quiser, e a leitura de cada uma não
                muda quando ele cria mais uma. */}
            <div
              ref={faixaRef}
              onPointerDown={panInicia}
              onPointerMove={panMove}
              onPointerUp={panFim}
              onPointerCancel={panFim}
              className={`kanban-faixa -mx-3 flex snap-x snap-mandatory gap-[var(--k-faixa-gap)] overflow-x-auto px-3 pb-2 stagger md:-mx-0 md:px-0 ${panning ? 'kanban-panning' : ''}`}
              style={{
                height: 'calc(100dvh - 260px)',
                minHeight: 460,
              }}
            >
              {/*
                As colunas saem da configuração, não do código: nome, cor e
                ordem vêm de `pipeline_stages`, e a que estiver oculta
                simplesmente não é desenhada. O conteúdo de cada uma continua
                vindo da mesma query de sempre — o que mudou é a apresentação.
              */}
              {colunasTopo.map((s, i) => {
                const cards = cardsDa(s);
                // Contadores de IA/atendimento existem só para as filas de
                // fábrica; numa coluna criada pelo cliente eles não têm
                // significado definido, então ficam zerados em vez de mostrar
                // número de outra fila.
                const extras = s.isCustom
                  ? { ia: 0, att: 0, icon: <Columns3 size={14} strokeWidth={1.9} /> }
                  : {
                      new: { ia: iaCountNovos, att: 0, icon: <MessageSquare size={14} strokeWidth={1.9} /> },
                      priority: { ia: iaCountPrio, att: attCountPrio, icon: <AlertCircle size={14} strokeWidth={1.9} /> },
                      urgency: { ia: 0, att: attCountUrg, icon: <Zap size={14} strokeWidth={1.9} /> },
                    }[s.status as 'new' | 'priority' | 'urgency'] ?? {
                      ia: 0, att: 0, icon: <Columns3 size={14} strokeWidth={1.9} />,
                    };

                return (
                  <Column
                    key={s.id}
                    mostrarDono={veTudo}
                    title={s.label}
                    tone={toneFromHex(s.color)}
                    icon={extras.icon}
                    count={cards.length}
                    iaCount={extras.ia}
                    attendingCount={extras.att}
                    cards={cards}
                    stage={s}
                    // O pulso continua sendo da fila de urgência de fábrica — é
                    // sinal de SLA estourando, não decoração da cor escolhida.
                    urgent={!s.isCustom && s.status === 'urgency'}
                    stages={stages}
                    onMove={handleMoveLead}
                    onOpenLead={setOpenLead}
                    onCreateLead={s.status !== 'converted' ? setCreateLeadStage : undefined}
                    podeEditar={podeEditarColunas}
                    ocupado={colunas.salvando}
                    podeMoverEsquerda={i > 0}
                    podeMoverDireita={i < colunasTopo.length - 1}
                    onMoverColuna={colunas.mover}
                    onMoverPasso={colunas.moverPasso}
                    onOcultarColuna={(id) => colunas.definirVisivel(id, false)}
                    onExcluirColuna={colunas.excluir}
                  />
                );
              })}
            </div>

            {/* Seção "Encerrados" foi removida — convertidos agora ficam bloqueados
                por 48h no banco e reabrem automaticamente em inbound novo. */}
            {stageDe('attending').visible && (
              <CollapsibleSection
                mostrarDono={veTudo}
                title={stageDe('attending').label}
                stage={stageDe('attending')}
                subtitle={`${queues.respondidos.length} conversas aguardando retorno do cliente`}
                icon={<CheckCheck size={18} strokeWidth={1.6} />}
                accent={stageDe('attending').color}
                cards={cardsDa(stageDe("attending"))}
                stages={stages}
                onMove={handleMoveLead}
                onOpen={setOpenLead}
                emptyText="Nenhum lead respondido ainda"
              />
            )}

            {/* Convertidos: lista de leitura abaixo de Respondidos. O lead fica
                aqui até alguém mandar mensagem pra ele (volta pra Respondidos)
                ou ele responder (volta pro pipeline). Abrir o card → modal com
                o botão "Reabrir" pra trazer de volta na mão. */}
            {stageDe('converted').visible && (
              <CollapsibleSection
                mostrarDono={veTudo}
                title={stageDe('converted').label}
                stage={stageDe('converted')}
                subtitle={`${queues.convertidos.length} ${queues.convertidos.length === 1 ? 'lead convertido' : 'leads convertidos'} · mande mensagem pra trazer de volta pra ${stageDe('attending').label}`}
                icon={<CircleCheckBig size={18} strokeWidth={1.6} />}
                accent={stageDe('converted').color}
                cards={cardsDa(stageDe("converted"))}
                stages={stages}
                onMove={handleMoveLead}
                onOpen={setOpenLead}
                emptyText="Nenhum lead convertido ainda"
              />
            )}
          </>
        )}
      </div>

      {configOpen && (
        <QueueConfigModal onClose={() => setConfigOpen(false)} />
      )}

      {createLeadStage && (
        <CreateLeadModal
          key={`${createLeadStage.id}:${activeConn}`}
          stages={stages}
          connections={connections}
          initialStage={createLeadStage}
          initialConnectionId={activeConn !== 'all' && !activeConn.startsWith('email') ? activeConn : null}
          onClose={() => setCreateLeadStage(null)}
          onCreated={(leadId) => {
            setCreateLeadStage(null);
            setOpenLead(leadId);
            void reload(true);
          }}
        />
      )}

      {openLead && (
        <LeadModal
          leadId={openLead}
          onClose={() => setOpenLead(null)}
          onChange={() => void reload(true)}
        />
      )}
    </div>
  );
}

function FiltersPanel({
  filters, onChange, mostrarCategorias = true,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  /** Falso no modo funil: as categorias são conceito de fila de atendimento. */
  mostrarCategorias?: boolean;
}) {
  function toggleCategory(c: QueueCategory) {
    const next = new Set(filters.categories);
    if (next.has(c)) next.delete(c); else next.add(c);
    onChange({ ...filters, categories: next });
  }

  return (
    <div
      className="mb-5 rounded-xl border p-4"
      style={{ background: '#111116', borderColor: 'var(--border-subtle)' }}
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <FilterInput
          label="Buscar conversa"
          icon={<Search size={12} strokeWidth={1.7} />}
          value={filters.name}
          onChange={(v) => onChange({ ...filters, name: v })}
          placeholder='Nome, telefone ou algo dito no chat (ex: "pix")'
          hint="Busca também dentro das mensagens, em todas as conversas (a partir de 2 letras)"
        />
        <FilterInput
          label="De"
          icon={<Calendar size={12} strokeWidth={1.7} />}
          type="datetime-local"
          value={filters.fromDate}
          onChange={(v) => onChange({ ...filters, fromDate: v })}
        />
        <FilterInput
          label="Até"
          icon={<Calendar size={12} strokeWidth={1.7} />}
          type="datetime-local"
          value={filters.toDate}
          onChange={(v) => onChange({ ...filters, toDate: v })}
        />
      </div>

      {mostrarCategorias && (
      <div className="mt-4">
        <div className="section-label mb-2 text-[10.5px]">Categorias</div>
        <div className="flex flex-wrap gap-1.5">
          {ALL_CATEGORIES.map((c) => {
            const active = filters.categories.has(c);
            return (
              <button
                key={c}
                type="button"
                onClick={() => toggleCategory(c)}
                className={`rounded-md px-2.5 py-1 text-[11.5px] transition ${
                  active ? 'text-white' : 'text-text-muted hover:text-text-secondary'
                }`}
                style={
                  active
                    ? { background: 'var(--accent-deep)', border: '1px solid rgba(var(--accent-light-rgb),0.4)' }
                    : { background: '#18181F', border: '1px solid var(--border-subtle)' }
                }
              >
                {CATEGORY_LABEL[c]}
              </button>
            );
          })}
        </div>
      </div>
      )}
    </div>
  );
}

function FilterInput({
  label, icon, value, onChange, placeholder, type = 'text', hint,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'datetime-local';
  hint?: string;
}) {
  return (
    <div>
      <label className="mb-1 flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-text-muted">
        {icon} {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border bg-[#18181F] px-2.5 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted focus:border-blue-light focus:outline-none"
        style={{ borderColor: 'var(--border-subtle)' }}
      />
      {hint && <div className="mt-1 text-[10px] text-text-muted">{hint}</div>}
    </div>
  );
}

function FilterTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-[12px] transition-all duration-150 ${
        active ? 'text-white' : 'text-text-muted hover:text-text-secondary'
      }`}
      style={
        active
          ? { background: 'var(--accent-deep)', boxShadow: 'inset 0 -2px 0 0 var(--accent-mid)' }
          : undefined
      }
    >
      {children}
    </button>
  );
}

function CollapsibleSection({
  title, subtitle, icon, accent, cards, stages, stage, onMove, onOpen, emptyText, mostrarDono,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  accent: string;
  cards: KanbanLead[];
  /** Colunas do quadro — repassadas ao card para montar os destinos. */
  stages: StageColumn[];
  /** A coluna que esta seção representa — destino quando um card é solto aqui. */
  stage: StageColumn;
  onMove: (leadId: string, newStatus: LeadStatus, stageId: string | null) => void;
  onOpen: (leadId: string) => void;
  emptyText: string;
  /** Marcar de quem é cada card. Só para quem vê mais de uma carteira. */
  mostrarDono?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [sobrevoando, setSobrevoando] = useState(false);
  const [visibleCount, setVisibleCount] = useState(CARDS_POR_LOTE);
  const visibleCards = cards.slice(0, visibleCount);
  return (
    <Card
      padding={0}
      className="mt-5 transition-colors"
      style={sobrevoando ? { borderColor: accent, background: `${accent}0F` } : undefined}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!sobrevoando) setSobrevoando(true);
        // Soltar numa seção fechada é frustrante: o card some de vista. Abrir no
        // sobrevoo mostra para onde ele está indo.
        if (!open) setOpen(true);
      }}
      onDragLeave={(e) => {
        if ((e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) return;
        setSobrevoando(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setSobrevoando(false);
        const leadId = e.dataTransfer.getData('application/x-lead-id');
        if (leadId) onMove(leadId, stage.status, stage.isCustom ? stage.id : null);
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 rounded-xl px-5 py-4 transition-colors hover:bg-[rgba(var(--accent-mid-rgb),0.04)]"
      >
        <div className="flex h-9 w-9 items-center justify-center rounded-lg"
          style={{ background: `${accent}1f`, color: accent }}>
          {icon}
        </div>
        <div className="flex-1 text-left">
          <div className="text-[13.5px] font-semibold text-text-primary">{title}</div>
          <div className="text-[11.5px] text-text-muted">{subtitle}</div>
        </div>
        <ChevronDown
          size={18}
          strokeWidth={1.6}
          className="text-text-muted transition-transform duration-200"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        />
      </button>
      {open && (
        <div className="grid grid-cols-1 gap-3 border-t px-4 py-4 sm:grid-cols-2 lg:grid-cols-3"
          style={{ borderColor: 'var(--border-subtle)' }}>
          {visibleCards.map((l) => (
            // Cards de "Respondidos" / outras seções colapsáveis: cinza neutro (tone undefined)
            <KanbanCard key={l.id} l={l} accent={accent} stages={stages} onMove={onMove} onOpen={onOpen} mostrarDono={mostrarDono} />
          ))}
          {cards.length === 0 && (
            <div className="col-span-full rounded-lg border border-dashed py-6 text-center text-[12px] text-text-muted"
              style={{ borderColor: 'var(--border-subtle)' }}>
              {emptyText}
            </div>
          )}
          {cards.length > visibleCount && (
            <button
              type="button"
              onClick={() => setVisibleCount((current) => current + CARDS_POR_LOTE)}
              className="col-span-full rounded-lg border border-dashed py-3 text-[12px] text-text-muted transition-colors hover:text-text-primary"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              Mostrar mais {Math.min(CARDS_POR_LOTE, cards.length - visibleCount)} leads
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

// ─── Busca de conversas (nome / telefone / conteúdo do chat) ───────────────

const STATUS_BADGE: Record<LeadStatus, { bg: string; color: string }> = {
  new:       { bg: 'rgba(0,212,146,0.12)',  color: '#00d492' },
  priority:  { bg: 'rgba(217,157,0,0.12)',  color: '#d99d00' },
  urgency:   { bg: 'rgba(255,96,96,0.14)',  color: '#ff6060' },
  attending: { bg: 'rgba(148,163,184,0.14)', color: '#cbd5e1' },
  converted: { bg: 'rgba(34,211,238,0.14)', color: '#22D3EE' },
  lost:      { bg: 'rgba(148,163,184,0.12)', color: '#94A3B8' },
};

/** Trecho da mensagem com o termo destacado, centrado em torno da 1ª ocorrência. */
function SearchSnippet({ text, term }: { text: string; term: string }) {
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) {
    return <span className="line-clamp-2">{text}</span>;
  }
  const start = Math.max(0, idx - 32);
  const pre = (start > 0 ? '…' : '') + text.slice(start, idx);
  const match = text.slice(idx, idx + term.length);
  const post = text.slice(idx + term.length);
  return (
    <span className="line-clamp-2">
      {pre}
      <mark className="rounded px-0.5" style={{ background: 'rgba(250,204,21,0.25)', color: '#FDE68A' }}>
        {match}
      </mark>
      {post}
    </span>
  );
}

function SearchResultsView({
  term, loading, results, onOpen, onClear,
}: {
  term: string;
  loading: boolean;
  results: ConversationSearchResult[];
  onOpen: (leadId: string) => void;
  onClear: () => void;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[12.5px] text-text-secondary">
          <Search size={14} strokeWidth={1.7} className="text-text-muted" />
          {loading ? (
            <span className="inline-flex items-center gap-1.5 text-text-muted">
              <Loader2 size={13} strokeWidth={1.7} className="animate-spin" /> Buscando “{term}”…
            </span>
          ) : (
            <span>
              <strong className="text-text-primary">{results.length}</strong>{' '}
              {results.length === 1 ? 'conversa encontrada' : 'conversas encontradas'} para “{term}”
            </span>
          )}
        </div>
        <button
          onClick={onClear}
          className="text-[11.5px] text-text-muted hover:text-text-secondary"
          title="Limpar busca"
        >
          limpar busca
        </button>
      </div>

      {!loading && results.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-[12.5px] text-text-muted"
          style={{ borderColor: 'var(--border-subtle)' }}>
          Nada encontrado para “{term}”. Tente outra palavra ou um número.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {results.map((r) => (
            <SearchResultCard key={r.id} r={r} term={term} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

function SearchResultCard({
  r, term, onOpen,
}: {
  r: ConversationSearchResult;
  term: string;
  onOpen: (leadId: string) => void;
}) {
  const color = colorFor(r.id);
  const title = leadDisplayName(r);
  const subtitle = leadDisplaySubtitle(r);
  const initials = leadInitials(r);
  const badge = STATUS_BADGE[r.status];
  const when = r.lastMessageAt ? new Date(r.lastMessageAt) : new Date(r.createdAt);

  return (
    <div
      onClick={() => onOpen(r.id)}
      className="group flex cursor-pointer flex-col rounded-xl border p-4 transition-all duration-200 hover:-translate-y-[1px] hover:shadow-[0_6px_24px_rgba(0,0,0,0.3)]"
      style={{ background: '#111116', borderColor: 'var(--border-subtle)' }}
    >
      <div className="mb-[var(--k-card-head-mb)] flex items-center gap-[var(--k-card-head-gap)]">
        <div
          className="flex h-[var(--k-card-avatar)] w-[var(--k-card-avatar)] shrink-0 items-center justify-center rounded-full text-[length:var(--k-card-avatar-fs)] font-semibold"
          style={{ background: `${color}33`, color, border: `1px solid ${color}55` }}
        >
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[length:var(--k-card-title)] font-semibold text-text-primary">{title}</div>
          {subtitle && <div className="truncate text-[length:var(--k-card-sub)] text-text-muted">{subtitle}</div>}
        </div>
        <span
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
          style={{ background: badge.bg, color: badge.color }}
        >
          {STATUS_LABEL[r.status]}
        </span>
      </div>

      <p className="mb-3 text-[12px] leading-snug text-text-secondary">
        {r.snippet ? (
          <SearchSnippet text={r.snippet} term={term} />
        ) : (
          <span className="text-text-muted italic">Casou pelo nome/telefone</span>
        )}
      </p>

      <div className="flex items-center justify-between text-[10.5px] text-text-muted">
        <span className="inline-flex items-center gap-1.5">
          <ChannelPill c={r.channel} />
          {r.connectionName && <span className="truncate">{r.connectionName}</span>}
        </span>
        <span className="tabular-nums">
          {when.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })}
        </span>
      </div>
    </div>
  );
}

function Column({
  title, tone, icon, count, iaCount, attendingCount, cards, urgent, stages, stage, onMove, onOpenLead,
  mostrarDono, podeEditar, ocupado, podeMoverEsquerda, podeMoverDireita,
  onMoverColuna, onMoverPasso, onOcultarColuna, onExcluirColuna, onCreateLead,
}: {
  title: string;
  /**
   * A paleta já resolvida, e não mais a chave de um tom fixo. Mudou porque a
   * cor da coluna passou a vir da configuração do cliente — `toneFromHex`
   * deriva o mesmo formato que o `TONE` sempre teve, então nada aqui dentro
   * precisou saber da mudança.
   */
  tone: ToneShape;
  icon: React.ReactNode;
  count: number;
  iaCount: number;
  attendingCount: number;
  cards: KanbanLead[];
  urgent?: boolean;
  /** Colunas do quadro — o card precisa delas para oferecer os destinos. */
  stages: StageColumn[];
  /** A coluna que este componente desenha — é o DESTINO quando algo é solto aqui. */
  stage: StageColumn;
  onMove: (leadId: string, newStatus: LeadStatus, stageId: string | null) => void;
  onOpenLead: (leadId: string) => void;
  onCreateLead?: (stage: StageColumn) => void;
  /** Marcar de quem é cada card. Só para quem vê a carteira de mais de um. */
  mostrarDono?: boolean;
  /** Admin: pode arrastar a coluna, escondê-la e apagá-la. */
  podeEditar?: boolean;
  /** Alguma mudança de coluna em voo — desabilita as ações até voltar. */
  ocupado?: boolean;
  podeMoverEsquerda?: boolean;
  podeMoverDireita?: boolean;
  onMoverColuna?: (arrastadaId: string, alvoId: string) => void;
  onMoverPasso?: (id: string, direcao: -1 | 1) => void;
  onOcultarColuna?: (id: string) => void;
  onExcluirColuna?: (id: string) => void;
}) {
  const C = tone;
  // Destacado enquanto um card sobrevoa esta coluna.
  const [sobrevoando, setSobrevoando] = useState(false);
  const [visibleCount, setVisibleCount] = useState(CARDS_POR_LOTE);
  const visibleCards = cards.slice(0, visibleCount);
  // Destacado enquanto OUTRA COLUNA sobrevoa esta. Estado separado do de card
  // porque o realce é outro: a coluna alvo mostra onde a arrastada vai cair,
  // então é contorno tracejado, e não o preenchimento de "solte o card aqui".
  const [colunaSobrevoando, setColunaSobrevoando] = useState(false);
  const [arrastandoColuna, setArrastandoColuna] = useState(false);

  /** Está sendo arrastada uma COLUNA (e não um card)? */
  function ehArrasteDeColuna(e: React.DragEvent): boolean {
    return Array.from(e.dataTransfer.types).includes(TIPO_ARRASTE_COLUNA);
  }

  /**
   * O card só pode ser solto onde a transição é permitida.
   *
   * A regra é a mesma que o backend aplica (`quickMoveTargets`) — se a UI
   * aceitasse o drop e o servidor recusasse, o card voltaria sozinho depois de
   * um instante e pareceria bug. Melhor não aceitar: o cursor já mostra que ali
   * não pode.
   */
  function aceita(e: React.DragEvent): boolean {
    const de = e.dataTransfer.getData('application/x-lead-status') as LeadStatus;
    const deStage = e.dataTransfer.getData('application/x-lead-stage');
    if (!de) return true; // navegador que esconde os dados no dragover
    const mesmaColuna = stage.isCustom ? deStage === stage.id : !deStage && de === stage.status;
    if (mesmaColuna) return false;
    if (!stage.isCustom && de === stage.status) return Boolean(deStage);
    return quickMoveTargets(de).includes(stage.status);
  }
  // A coluna de urgência pulsa quando tem leads. Implementação: overlay
  // absoluto SEPARADO (pointer-events:none) por cima da coluna — anima border
  // + glow. Não toca o layout flex da coluna em si, então não quebra render.
  //
  // Antes o gatilho era a cor (`tone === 'err'`); agora é a prop `urgent`,
  // porque a cor virou escolha do cliente e um vermelho em "Novos" não deveria
  // fazer a coluna pulsar como se fosse SLA estourando.
  const pulse = Boolean(urgent) && cards.length > 0;

  return (
    <div
      onDragOver={(e) => {
        // Duas coisas diferentes podem estar sendo arrastadas até aqui. A
        // distinção sai de `dataTransfer.types`, e não de `getData`, porque
        // durante o `dragover` o navegador esconde o CONTEÚDO por segurança —
        // mas expõe os tipos, que é justamente o que basta para decidir.
        if (ehArrasteDeColuna(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (!colunaSobrevoando) setColunaSobrevoando(true);
          return;
        }
        // Sem o preventDefault o navegador NÃO dispara o drop — é o jeito
        // (pouco intuitivo) de dizer "aceito o que está sendo arrastado".
        if (!aceita(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!sobrevoando) setSobrevoando(true);
      }}
      onDragLeave={(e) => {
        // Só apaga o destaque quando o ponteiro sai da COLUNA — sem isto, passar
        // por cima de um card filho já apagaria o realce e ele piscaria.
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setSobrevoando(false);
        setColunaSobrevoando(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setSobrevoando(false);
        setColunaSobrevoando(false);
        const colunaId = e.dataTransfer.getData(TIPO_ARRASTE_COLUNA);
        if (colunaId) {
          if (colunaId !== stage.id) onMoverColuna?.(colunaId, stage.id);
          return;
        }
        const leadId = e.dataTransfer.getData('application/x-lead-id');
        if (leadId) onMove(leadId, stage.status, stage.isCustom ? stage.id : null);
      }}
      className="relative flex h-full min-h-0 w-[var(--k-col-w-mob)] shrink-0 snap-start flex-col rounded-[var(--k-col-radius)] border transition-colors sm:w-[var(--k-col-w)]"
      style={{
        background: sobrevoando ? C.bg : '#0D0D12',
        borderColor: colunaSobrevoando || sobrevoando ? C.text : 'var(--border-subtle)',
        // Tracejado = "a coluna que você está arrastando vai cair aqui".
        // Preenchimento = "solte o card aqui". Dois gestos, dois sinais.
        borderStyle: colunaSobrevoando ? 'dashed' : 'solid',
        // A coluna que saiu para a mão fica apagada, como o card já faz.
        opacity: arrastandoColuna ? 0.4 : 1,
      }}
    >
      {pulse && <span aria-hidden className="urgency-glow pointer-events-none absolute -inset-px rounded-[var(--k-col-radius)]" />}
      {/*
        O cabeçalho é a alça: é ele que arrasta a coluna, não a coluna inteira,
        senão pegar um card já seria pegar a coluna junto.

        `draggable` também é o que mantém o gesto de rolar a faixa intacto —
        `panInicia` ignora de propósito qualquer `[draggable="true"]`, botão,
        link e campo, então o pan continua acontecendo só no espaço vazio.
      */}
      <div
        draggable={Boolean(podeEditar)}
        onDragStart={(e) => {
          if (!podeEditar) return;
          e.dataTransfer.setData(TIPO_ARRASTE_COLUNA, stage.id);
          e.dataTransfer.effectAllowed = 'move';
          setArrastandoColuna(true);
        }}
        onDragEnd={() => setArrastandoColuna(false)}
        className={`relative z-[1] flex flex-col gap-[var(--k-col-head-gap)] rounded-t-[var(--k-col-radius)] border-b px-[var(--k-col-head-px)] py-[var(--k-col-head-py)] ${
          podeEditar ? 'cursor-grab active:cursor-grabbing' : ''
        }`}
        style={{ background: C.bg, borderColor: C.border }}
        title={podeEditar ? 'Arraste para mudar a coluna de lugar' : undefined}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2" style={{ color: C.text }}>
            <span className="relative inline-flex h-2 w-2 items-center justify-center">
              <span
                className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
                style={{ background: C.text }}
              />
              <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: C.text, boxShadow: `0 0 6px ${C.glow}` }} />
            </span>
            <span style={{ color: C.text }}>{icon}</span>
            <span className="truncate text-[length:var(--k-col-title)] font-bold" style={{ color: C.text }}>{title}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <span
              className="inline-flex h-[var(--k-col-badge-h)] min-w-[var(--k-col-badge-min)] items-center justify-center rounded-full px-[var(--k-col-badge-px)] text-[length:var(--k-col-badge-fs)] font-bold tabular-nums"
              style={{ background: C.text, color: '#0B0B10' }}
            >
              {count}
            </span>
            {onCreateLead && (
              <button
                type="button"
                draggable={false}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onCreateLead(stage);
                }}
                aria-label={`Criar lead em ${title}`}
                title={`Criar lead em ${title}`}
                className="grid h-6 w-6 place-items-center rounded-md transition hover:bg-white/10"
                style={{ color: C.text }}
              >
                <Plus size={13} strokeWidth={2.2} />
              </button>
            )}
            {podeEditar && (
              <ColumnMenu
                stage={stage}
                cor={C.text}
                ocupado={Boolean(ocupado)}
                podeMoverEsquerda={Boolean(podeMoverEsquerda)}
                podeMoverDireita={Boolean(podeMoverDireita)}
                onMoverPasso={(direcao) => onMoverPasso?.(stage.id, direcao)}
                onOcultar={() => onOcultarColuna?.(stage.id)}
                onExcluir={() => onExcluirColuna?.(stage.id)}
              />
            )}
          </div>
        </div>
        {(iaCount > 0 || attendingCount > 0) && (
          <div className="flex items-center gap-[var(--k-col-sub-gap)] text-[length:var(--k-col-sub)]" style={{ color: C.text }}>
            {iaCount > 0 && (
              <span className="inline-flex items-center gap-1 opacity-90">
                <Bot size={11} strokeWidth={1.7} />
                {iaCount} com IA
              </span>
            )}
            {attendingCount > 0 && (
              <span className="inline-flex items-center gap-1 opacity-90">
                <UserRound size={11} strokeWidth={1.7} />
                {attendingCount} atendendo
              </span>
            )}
          </div>
        )}
      </div>
      {/*
        A scrollbar seguia o `data-tone` por CSS, que só conhecia info/warn/err.
        Com cor configurável isso não escala, então a cor vai inline — o
        `scrollbar-color` do padrão cobre Firefox, e o webkit cai no default,
        que é o mesmo comportamento de quem já usava um tom fora dos três.
      */}
      <div
        className="kanban-scroll relative z-[1] flex flex-1 flex-col gap-[var(--k-col-list-gap)] overflow-y-auto p-[var(--k-col-list-p)] stagger"
        style={{ scrollbarColor: `${C.glow} transparent` }}
      >
        {visibleCards.map(l => <KanbanCard key={l.id} l={l} accent={C.text} tone={C.text} urgent={urgent} stages={stages} onMove={onMove} onOpen={onOpenLead} mostrarDono={mostrarDono} />)}
        {cards.length === 0 && (
          <div className="rounded-lg border border-dashed py-10 text-center text-[12px] text-text-muted" style={{ borderColor: 'var(--border-subtle)' }}>
            Nenhum lead nesta fila
          </div>
        )}
        {cards.length > visibleCount && (
          <button
            type="button"
            onClick={() => setVisibleCount((current) => current + CARDS_POR_LOTE)}
            className="rounded-lg border border-dashed py-3 text-[12px] text-text-muted transition-colors hover:text-text-primary"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            Mostrar mais {Math.min(CARDS_POR_LOTE, cards.length - visibleCount)} leads
          </button>
        )}
      </div>
    </div>
  );
}

function senderPrefix(sender: NonNullable<KanbanLead['lastMessageSender']>): string {
  switch (sender) {
    case 'ai':    return 'IA';
    case 'human': return 'Você';
    case 'owner': return 'Dono';
    default:      return '';
  }
}

function colorFor(id: string): string {
  const palette = ['#C08BFF', '#22D3EE', '#F472B6', '#A78BFA', '#FBBF24', '#4ADE80', '#F87171', '#818CF8'];
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

/**
 * Estilo de card por fila — pedido do usuário:
 *   - Novos: cinza neutro, sem tinta de status (card "limpo")
 *   - Prioridade: degradê amarelado em cima, dissolvendo pro cinza embaixo
 *   - Urgência: vermelho saturado em quase toda a área do card
 *   - Atendendo (Respondidos): cinza neutro também (mantém o resto da UI sereno)
 */
/**
 * Fundo e borda do card, derivados da cor da coluna.
 *
 * Antes eram três casos fixos (`warn` escurecia para âmbar, `err` para
 * vermelho, o resto era neutro). Com a cor virando escolha do cliente, o mesmo
 * efeito passa a ser calculado: o fundo é a cor num alfa muito baixo sobre o
 * cinza do quadro, e a borda a mesma cor num alfa médio. Uma coluna âmbar
 * continua com o card âmbar; uma coluna roxa ganha o card roxo, sem precisar
 * de um caso novo aqui.
 *
 * Sem cor (as seções e o resultado de busca) mantém o neutro de sempre.
 */
function cardBackgroundForTone(color?: string): { background: string; borderColor: string } {
  if (!color) return { background: '#111116', borderColor: 'var(--border-subtle)' };

  const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(color.replace(/\s/g, ''))
    ?? /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return { background: '#111116', borderColor: 'var(--border-subtle)' };

  const [r, g, b] = m.length === 4
    ? [Number(m[1]), Number(m[2]), Number(m[3])]
    : [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));

  return {
    // 0.055 é o que reproduz a densidade dos fundos fixos que existiam antes
    // (#1A1408 e #180B0D) sobre o cinza #111116 do quadro.
    background: `rgba(${r},${g},${b},0.055)`,
    borderColor: `rgba(${r},${g},${b},0.30)`,
  };
}

/**
 * Botões fixos de movimentação por status. Sempre dois alvos (os outros dois
 * status do tripé Novos/Prioridade/Urgência), com cor casando com o destino:
 *   - Novos    → verde info
 *   - Prioridade → amarelo warn
 *   - Urgência → vermelho err
 *
 * Pra 'attending' (Respondidos), oferece reabrir como Novos e escalar pra
 * Urgência — coberturas que casam com "lead voltou a falar" ou "virou problema".
 */
function quickMoveTargets(from: LeadStatus): LeadStatus[] {
  switch (from) {
    case 'new':       return ['priority', 'urgency'];
    case 'priority':  return ['new', 'urgency'];
    case 'urgency':   return ['new', 'priority'];
    case 'attending': return ['new', 'urgency'];
    default:          return []; // converted/lost ficam fora do kanban
  }
}

function moveButtonStyle(status: LeadStatus): { bg: string; border: string; color: string; label: string } {
  if (status === 'new') {
    return {
      bg: 'rgba(0,212,146,0.10)', border: 'rgba(0,212,146,0.45)', color: '#00d492',
      label: 'Novos',
    };
  }
  if (status === 'priority') {
    return {
      bg: 'rgba(217,157,0,0.10)', border: 'rgba(217,157,0,0.45)', color: '#d99d00',
      label: 'Prioridade',
    };
  }
  if (status === 'urgency') {
    return {
      bg: 'rgba(255,96,96,0.12)', border: 'rgba(255,96,96,0.50)', color: '#ff6060',
      label: 'Urgência',
    };
  }
  return { bg: '#1C1C28', border: 'var(--border-subtle)', color: '#cbd5e1', label: STATUS_LABEL[status] };
}

function KanbanCard({
  l, tone, urgent, stages, onMove, onOpen, mostrarDono,
}: {
  l: KanbanLead;
  accent?: string;
  /** Cor da coluna (`rgb(...)` ou `#RRGGBB`) — antes era a chave de um tom fixo. */
  tone?: string;
  urgent?: boolean;
  /** Colunas do quadro — os atalhos de mover saem daqui, não de uma lista fixa. */
  stages: StageColumn[];
  onMove: (leadId: string, newStatus: LeadStatus, stageId: string | null) => void;
  onOpen: (leadId: string) => void;
  /** Marcar de quem é o card. Só para quem vê a carteira de mais de um. */
  mostrarDono?: boolean;
}) {
  // Quando awaitingMinutes é null, a última msg foi NOSSA: card mostra "Respondido"
  // em cinza e não conta tempo. Senão, cor escala com tempo sem resposta.
  const awaitingMin = l.awaitingMinutes;
  const awaitingSec = l.awaitingSeconds;
  const isResponded = awaitingMin === null;
  const lastAt = l.lastMessageAt ? new Date(l.lastMessageAt) : null;
  // Arquivado pelo botão "Resolvido" MAS o cliente nunca foi respondido (a
  // última mensagem ainda é dele). É o descarte silencioso, que antes se
  // escondia na coluna Respondidos parecendo atendimento concluído.
  const resolvedNoResponse = !!l.resolvedAt && !isResponded;
  const timerTone = isResponded
    ? '#4ADE80'
    : (awaitingMin ?? 0) > 120
    ? '#ff6060'
    : (awaitingMin ?? 0) > 60
    ? '#d99d00'
    : '#94A3B8';
  const color = colorFor(l.id);
  const initials = leadInitials(l);
  const title = leadDisplayName(l);
  const subtitle = leadDisplaySubtitle(l);
  const cardBg = cardBackgroundForTone(tone);
  // Enquanto arrasta, o card original fica apagado — dá a sensação de que ele
  // "saiu" e está na mão, em vez de existir em dois lugares.
  const [arrastando, setArrastando] = useState(false);

  /**
   * Destinos oferecidos no card.
   *
   * Sai das COLUNAS configuradas, não de uma lista fixa de status: assim uma
   * coluna criada pelo cliente aparece como destino sem que este componente
   * saiba que ela existe. A regra de quais transições valem continua sendo a
   * do backend (`quickMoveTargets`), aplicada ao status âncora de cada coluna —
   * o que impede a coluna nova de virar um atalho para um movimento proibido.
   *
   * A coluna onde o card já está fica de fora, e as ocultas também.
   */
  const destinos = (() => {
    const permitidos = new Set<string>(quickMoveTargets(l.status));
    const atual = l.stageId ?? `padrao:${l.status}`;
    return stages.filter((s) => {
      if (!s.visible) return false;
      if ((s.isCustom ? s.id : `padrao:${s.status}`) === atual) return false;
      // Coluna de fábrica do próprio status: já é onde o card estaria sem
      // personalização, então só faz sentido como "voltar" — e aí o status
      // não muda, o que o backend aceita.
      if (!s.isCustom && s.status === l.status) return Boolean(l.stageId);
      return permitidos.has(s.status);
    });
  })();

  return (
    <div
      draggable
      onDragStart={(e) => {
        // Três dados: quem arrastar, de qual status e de qual coluna. Os dois
        // últimos são o que permite à coluna de destino decidir, no `dragover`,
        // se aceita — antes de o usuário soltar.
        e.dataTransfer.setData('application/x-lead-id', l.id);
        e.dataTransfer.setData('application/x-lead-status', l.status);
        e.dataTransfer.setData('application/x-lead-stage', l.stageId ?? '');
        e.dataTransfer.effectAllowed = 'move';
        setArrastando(true);
      }}
      onDragEnd={() => setArrastando(false)}
      className="group relative flex cursor-grab flex-col rounded-[var(--k-card-radius)] border px-[var(--k-card-px)] py-[var(--k-card-py)] transition-all duration-200 hover:-translate-y-[1px] hover:shadow-[0_6px_24px_rgba(0,0,0,0.3)] active:cursor-grabbing"
      onClick={() => onOpen(l.id)}
      style={{
        background: cardBg.background,
        borderColor: cardBg.borderColor,
        opacity: arrastando ? 0.4 : 1,
      }}
    >
      <div className="mb-[var(--k-card-head-mb)] flex items-center gap-[var(--k-card-head-gap)]">
        <div
          className="flex h-[var(--k-card-avatar)] w-[var(--k-card-avatar)] shrink-0 items-center justify-center rounded-full text-[length:var(--k-card-avatar-fs)] font-semibold"
          style={{ background: `${color}33`, color, border: `1px solid ${color}55` }}
        >
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[length:var(--k-card-title)] font-semibold text-text-primary">{title}</span>
            {l.unread && <span className="h-1.5 w-1.5 rounded-full bg-blue-light animate-pulse-dot" />}
            {/* De quem é esta conversa. Só aparece para quem enxerga mais de
                uma carteira — para o próprio BDR seria a mesma letra em todos
                os cards, ocupando espaço num card que é de propósito apertado. */}
            {mostrarDono && <DonoPill nome={l.ownerName} />}
          </div>
          {subtitle && (
            <div className="truncate text-[length:var(--k-card-sub)] text-text-muted">{subtitle}</div>
          )}
        </div>
      </div>

      <p className="kanban-preview mb-[var(--k-card-prev-mb)] line-clamp-2 text-[length:var(--k-card-prev-fs)] leading-snug text-text-secondary">
        {l.lastMessage ? (
          <>
            {l.lastMessageSender && l.lastMessageSender !== 'lead' && (
              <span
                className="mr-1 font-semibold"
                style={{ color: l.lastMessageSender === 'ai' ? '#A78BFA' : 'var(--accent-light)' }}
              >
                {senderPrefix(l.lastMessageSender)}:
              </span>
            )}
            {l.lastMessage}
          </>
        ) : (
          <span className="text-text-muted italic">(sem mensagens)</span>
        )}
      </p>

      <div className="mb-[var(--k-card-pills-mb)] flex flex-wrap items-center gap-[var(--k-card-pills-gap)]">
        <ChannelPill c={l.channel} />
        <AssigneePill aiActive={l.aiAgentActive} aiPausedUntil={l.aiPausedUntil} attendant={l.assignedToName} />
        {resolvedNoResponse && (
          <span
            className="inline-flex items-center gap-1 rounded-full px-[var(--k-card-pill-px)] py-[var(--k-card-pill-py)] text-[length:var(--k-card-pill-fs)] font-semibold"
            style={{ background: 'rgba(255,96,96,0.12)', color: '#ff6060', border: '1px solid rgba(255,96,96,0.45)' }}
            title="Foi marcado como Resolvido, mas o cliente nunca recebeu resposta"
          >
            <TriangleAlert size={10} strokeWidth={2} />
            Resolvido sem resposta
          </span>
        )}
      </div>

      <div className="flex items-center justify-between text-[10.5px]">
        <div className="inline-flex items-center gap-1 tabular-nums"
          style={{ color: timerTone }}
        >
          <Clock size={11} strokeWidth={1.6} className={urgent && !isResponded ? 'animate-soft-pulse' : ''} />
          {isResponded ? 'Respondido' : `${formatAge(awaitingMin ?? 0, awaitingSec ?? undefined)} sem resposta`}
          {/* Data e hora da última mensagem. O tempo relativo responde "está
              esperando há quanto?"; o absoluto responde "quando foi?" — e sem
              ele não dá pra situar a conversa no dia. */}
          {lastAt && (
            <span className="text-text-muted" title={lastAt.toLocaleString('pt-BR')}>
              · {formatStamp(lastAt)}
            </span>
          )}
        </div>
        {l.attendants.length > 0 && (
          <AttendantsStack attendants={l.attendants} />
        )}
      </div>

      {/*
        Atalhos de mover.

        SEMPRE no celular: a API de drag-and-drop do navegador não dispara com
        o dedo, e sem estes botões não haveria NENHUMA forma de mover um card
        pelo telefone.

        No desktop depende da densidade (`.kanban-mover`, em globals.css): o
        quadro compacto os esconde, porque o cliente de prospecção pediu só o
        arraste; o confortável os mantém, porque o time de atendimento já os
        usava e some-los sem aviso muda o hábito de quem trabalha ali.
      */}
      {destinos.length > 0 && (
        <div
          className="kanban-mover pointer-events-none absolute left-1/2 top-full z-20 flex max-w-[92vw] -translate-x-1/2 -translate-y-1 flex-wrap justify-center gap-1.5 rounded-full border px-1.5 py-1 opacity-0 shadow-lg transition-all duration-150 group-hover:pointer-events-auto group-hover:-translate-y-1/2 group-hover:opacity-100 focus-within:pointer-events-auto focus-within:-translate-y-1/2 focus-within:opacity-100"
          style={{
            background: '#0F0F14',
            borderColor: 'var(--border-subtle)',
            boxShadow: '0 10px 24px rgba(0,0,0,0.45)',
          }}
        >
          {destinos.map(destino => (
            <button
              key={destino.id}
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                // Coluna personalizada leva o id junto; a de fábrica manda
                // `null`, que é o que devolve o card ao fluxo normal.
                onMove(l.id, destino.status, destino.isCustom ? destino.id : null);
              }}
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition hover:brightness-125"
              style={{
                background: `${destino.color}1A`,
                color: destino.color,
                border: `1px solid ${destino.color}55`,
              }}
              title={`Mover pra ${destino.label}`}
            >
              <ArrowRight size={11} strokeWidth={2} />
              {destino.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Formato de "tempo na fila":
 *   < 60s        → "Xs"
 *   < 60min      → "Xmin"
 *   >= 60min     → "1h25min" / "2h" (omite minutos se for 0)
 */
/**
 * Data e hora curtas da última mensagem. Hoje mostra só a hora; outro dia
 * mostra dia/mês + hora. O tempo relativo ao lado responde "espera há quanto";
 * este responde "quando foi" — sem ele não dá pra situar a conversa no dia.
 */
function formatStamp(d: Date): string {
  const hoje = new Date();
  const mesmoDia =
    d.getDate() === hoje.getDate() &&
    d.getMonth() === hoje.getMonth() &&
    d.getFullYear() === hoje.getFullYear();
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (mesmoDia) return hora;
  const dia = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  return `${dia} ${hora}`;
}

function formatAge(ageMinutes: number, ageSeconds?: number): string {
  if (typeof ageSeconds === 'number' && ageSeconds < 60) {
    return `${Math.max(0, ageSeconds)}s`;
  }
  if (ageMinutes < 60) return `${ageMinutes}min`;
  const h = Math.floor(ageMinutes / 60);
  const m = ageMinutes % 60;
  return m > 0 ? `${h}h${m}min` : `${h}h`;
}

function targetColor(status: LeadStatus): string {
  if (status === 'priority') return '#d99d00';
  if (status === 'urgency') return '#ff6060';
  if (status === 'attending') return '#94A3B8';
  if (status === 'converted') return '#22D3EE';
  if (status === 'lost') return '#94A3B8';
  return '#cbd5e1';
}

/**
 * Inicial do BDR dono da conversa.
 *
 * Um círculo com uma letra, e não o nome inteiro: o card é apertado de
 * propósito, e num quadro com centenas deles o que o admin precisa é
 * DISTINGUIR de quem é cada um, não ler o nome. A cor sai do próprio nome, e
 * não de uma paleta por índice, para a mesma pessoa ter sempre a mesma cor em
 * qualquer tela e em qualquer ordem de carregamento.
 */
function DonoPill({ nome }: { nome: string | null }) {
  // Sem dono é lead da casa — some em vez de virar um "?" que ninguém explica.
  if (!nome) return null;
  const letra = nome.trim().charAt(0).toUpperCase();
  let h = 0;
  for (let i = 0; i < nome.length; i++) h = (h * 31 + nome.charCodeAt(i)) % 360;
  const cor = `hsl(${h} 70% 68%)`;
  return (
    <span
      title={nome}
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold"
      style={{ background: `hsl(${h} 70% 68% / 0.18)`, color: cor, border: `1px solid hsl(${h} 70% 68% / 0.45)` }}
    >
      {letra}
    </span>
  );
}

/**
 * Selo do canal do lead.
 *
 * Recebe o canal INTEIRO e não um "é WhatsApp?": a versão anterior decidia com
 * `channel === 'whatsapp' ? 'WA' : 'IG'`, e todo canal que não fosse WhatsApp
 * virava Instagram na tela — um lead de e-mail aparecia marcado como Instagram.
 * O "IG" nunca chegou a estar certo: Instagram é canal de ORIGEM comercial
 * (`attributedChannel`), não de conversa — não existe adapter de conversa por
 * IG. Só não incomodava enquanto WhatsApp era o único canal de verdade.
 *
 * O `satisfies` é o que impede a volta disso: canal novo no enum sem selo aqui
 * vira erro de compilação, e não etiqueta errada na tela do cliente.
 */
const CANAL_PILL = {
  whatsapp: { sigla: 'WA', cor: '#4ADE80', fundo: 'rgba(34,197,94,0.15)' },
  email: { sigla: 'E-MAIL', cor: '#7DD3FC', fundo: 'rgba(56,189,248,0.15)' },
  manual: { sigla: 'MANUAL', cor: '#C4B5FD', fundo: 'rgba(167,139,250,0.15)' },
} satisfies Record<KanbanLead['channel'], { sigla: string; cor: string; fundo: string }>;

function ChannelPill({ c }: { c: KanbanLead['channel'] }) {
  const p = CANAL_PILL[c];
  return (
    <span className="inline-flex items-center gap-1 rounded-md px-1.5 text-[10px] font-semibold"
      style={{ background: p.fundo, color: p.cor, height: 18 }}>
      {p.sigla}
    </span>
  );
}

/**
 * Stack de avatars dos atendentes HUMANOS que já interagiram no lead (ordem:
 * última interação primeiro). Mostra até 3 avatars; demais viram "+N".
 * Avatar único expande pra "Atendente Carlos"; vários mostram só os círculos
 * sobrepostos com tooltip listando todos.
 */
function AttendantsStack({ attendants }: { attendants: KanbanAttendant[] }) {
  if (attendants.length === 0) return null;
  const visible = attendants.slice(0, 3);
  const extra = attendants.length - visible.length;

  // Caso especial: 1 atendente — mostra avatar + label "Atendente Nome" como antes.
  if (attendants.length === 1) {
    const a = attendants[0];
    const firstName = a.name.trim().split(/\s+/)[0] ?? a.name;
    const initial = (firstName[0] ?? '?').toUpperCase();
    const color = colorFor(firstName);
    const prefix = a.role === 'admin' ? 'Gerente' : 'Atendente';
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full text-[10.5px] font-medium"
        style={{ color: '#cbd5e1' }}
        title={`Último: ${prefix} ${a.name}`}
      >
        <span
          className="flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold"
          style={{ background: `${color}33`, color, border: `1px solid ${color}55` }}
        >
          {initial}
        </span>
        {prefix} {firstName}
      </span>
    );
  }

  // Múltiplos atendentes — só os círculos sobrepostos.
  const tooltip = attendants
    .map(a => {
      const prefix = a.role === 'admin' ? 'Gerente' : 'Atendente';
      return `${prefix} ${a.name}`;
    })
    .join('\n');

  return (
    <span
      className="inline-flex items-center gap-1 text-[10.5px] font-medium text-text-secondary"
      title={tooltip}
    >
      <span className="flex -space-x-1.5">
        {visible.map(a => {
          const firstName = a.name.trim().split(/\s+/)[0] ?? a.name;
          const initial = (firstName[0] ?? '?').toUpperCase();
          const color = colorFor(firstName);
          return (
            <span
              key={`${a.id ?? a.name}-${String(a.lastInteractionAt)}`}
              className="flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold ring-1"
              style={{
                background: `${color}33`,
                color,
                borderColor: `${color}55`,
                borderWidth: 1,
                borderStyle: 'solid',
                // ring-color usado pra "borda" do empilhamento
                boxShadow: '0 0 0 1.5px #0F0F14',
              }}
            >
              {initial}
            </span>
          );
        })}
      </span>
      {extra > 0 && (
        <span className="text-text-muted">+{extra}</span>
      )}
    </span>
  );
}

function AssigneePill({
  aiActive,
  aiPausedUntil,
  attendant,
}: {
  aiActive: boolean;
  aiPausedUntil?: Date | string | null;
  attendant: string | null;
}) {
  // aiPausedUntil pode chegar como string ISO (JSON) ou Date — normalizar.
  const pausedUntilMs = aiPausedUntil ? new Date(aiPausedUntil).getTime() : 0;
  const isPaused = aiActive && pausedUntilMs > Date.now();
  if (isPaused) {
    const hhmm = new Date(pausedUntilMs).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md px-1.5 text-[10px] font-semibold"
        style={{ background: 'rgba(250,204,21,0.15)', color: '#FACC15', height: 18 }}
        title={`IA em pausa silenciosa até ${hhmm}. Clique no chat pra retomar.`}
      >
        <Bot size={10} strokeWidth={1.7} /> Pausada {hhmm}
      </span>
    );
  }
  if (aiActive)
    return (
      <span className="inline-flex items-center gap-1 rounded-md px-1.5 text-[10px] font-semibold"
        style={{ background: 'var(--accent-deep)', color: 'var(--accent-light)', height: 18 }}>
        <Bot size={10} strokeWidth={1.7} /> IA
      </span>
    );
  if (!attendant)
    return (
      <span className="inline-flex items-center gap-1 rounded-md px-1.5 text-[10px] font-semibold"
        style={{ background: '#1C1C28', color: '#94A3B8', height: 18 }}>
        Aguardando
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-md px-1.5 text-[10px] font-semibold"
      style={{ background: '#18181F', color: '#F8FAFC', border: '1px solid var(--border-subtle)', height: 18 }}>
      <UserRound size={10} strokeWidth={1.7} /> {attendant}
    </span>
  );
}

// ─── Modal de Configurações de Fila ────────────────────────────────────

function QueueConfigModal({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<PipelineConfig | null>(null);
  const [draft, setDraft] = useState<PipelineConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/pipeline-config', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { config: PipelineConfig }) => {
        if (!cancelled) {
          setConfig(j.config);
          setDraft(j.config);
        }
      })
      .catch((e) => !cancelled && setErr(e instanceof Error ? e.message : 'Erro carregando config'));
    return () => { cancelled = true; };
  }, []);

  const dirty = !!(config && draft && (
    draft.newToPriorityMinutes !== config.newToPriorityMinutes ||
    draft.priorityToUrgencyMinutes !== config.priorityToUrgencyMinutes ||
    draft.autoEscalationEnabled !== config.autoEscalationEnabled
  ));

  async function save() {
    if (!draft) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch('/api/admin/pipeline-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as { config: PipelineConfig };
      setConfig(j.config);
      setDraft(j.config);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Erro');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4"
      style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="relative max-h-[92dvh] w-full max-w-full overflow-y-auto rounded-t-2xl border p-4 sm:max-h-[88vh] sm:max-w-lg sm:rounded-2xl sm:p-6"
        style={{ background: '#0F0F14', borderColor: 'var(--border-subtle)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-5 flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
            style={{ background: 'rgba(var(--accent-light-rgb),0.15)', color: 'var(--accent-light)' }}>
            <Settings size={16} strokeWidth={1.7} />
          </div>
          <div className="flex-1">
            <div className="text-[15px] font-semibold text-text-primary">Configurações de Fila</div>
            <div className="text-[12px] text-text-muted">Tempos de escalonamento automático</div>
          </div>
          <button onClick={onClose} aria-label="Fechar" className="text-text-muted hover:text-text-primary">
            <X size={18} strokeWidth={1.6} />
          </button>
        </div>

        {!draft ? (
          <div className="flex h-32 items-center justify-center text-text-muted">
            <Loader2 size={18} strokeWidth={1.6} className="animate-spin" />
          </div>
        ) : (
          <>
            {/* Flow visualization */}
            <div className="mb-5 flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-[11.5px]"
              style={{ background: '#18181F', borderColor: 'var(--border-subtle)' }}>
              <FlowPill icon={<MessageSquare size={11} strokeWidth={1.8} />} label="Novo" tone="info" />
              <span className="text-text-muted">→</span>
              <span className="font-semibold tabular-nums text-text-secondary">{draft.newToPriorityMinutes}min</span>
              <span className="text-text-muted">→</span>
              <FlowPill icon={<TriangleAlert size={11} strokeWidth={1.8} />} label="Prioridade" tone="warn" />
              <span className="text-text-muted">→</span>
              <span className="font-semibold tabular-nums text-text-secondary">{draft.priorityToUrgencyMinutes}min</span>
              <span className="text-text-muted">→</span>
              <FlowPill icon={<Flame size={11} strokeWidth={1.8} />} label="Urgência" tone="err" />
            </div>

            {/* Section 1 */}
            <SliderSection
              title="Novo → Prioridade"
              description="Tempo sem atendimento para escalar para Prioridade"
              valueLabel={`${draft.newToPriorityMinutes} min`}
              tone="warn"
              value={draft.newToPriorityMinutes}
              onChange={(v) => setDraft({ ...draft, newToPriorityMinutes: v })}
            />

            {/* Section 2 */}
            <SliderSection
              title="Prioridade → Urgência"
              description="Tempo adicional para escalar para Urgência"
              valueLabel={`${draft.priorityToUrgencyMinutes} min`}
              tone="err"
              value={draft.priorityToUrgencyMinutes}
              onChange={(v) => setDraft({ ...draft, priorityToUrgencyMinutes: v })}
            />

            {/* Master toggle */}
            <div className="mb-5 flex items-center justify-between rounded-xl border px-4 py-3"
              style={{ background: '#18181F', borderColor: 'var(--border-subtle)' }}>
              <div>
                <div className="text-[13px] font-semibold text-text-primary">Escalonamento automático</div>
                <div className="text-[11.5px] text-text-muted">Mover automaticamente entre filas por tempo</div>
              </div>
              <Toggle
                checked={draft.autoEscalationEnabled}
                onChange={(v) => setDraft({ ...draft, autoEscalationEnabled: v })}
                ariaLabel="Escalonamento automático"
              />
            </div>

            {err && (
              <div className="mb-3 rounded-md px-3 py-2 text-[11.5px]"
                style={{ background: 'rgba(248,113,113,0.08)', color: '#F87171' }}>
                {err}
              </div>
            )}

            <button
              onClick={save}
              disabled={saving || !dirty}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-500 py-3 text-[13px] font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-40 hover:bg-blue-600"
            >
              {saving ? <Loader2 size={14} strokeWidth={1.7} className="animate-spin" /> : <Save size={14} strokeWidth={1.7} />}
              Salvar Configurações
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function FlowPill({ icon, label, tone }: { icon: React.ReactNode; label: string; tone: Tone }) {
  const C = TONE[tone];
  return (
    <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold"
      style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}` }}>
      {icon} {label}
    </span>
  );
}

function SliderSection({
  title, description, valueLabel, tone, value, onChange,
}: {
  title: string;
  description: string;
  valueLabel: string;
  tone: Tone;
  value: number;
  onChange: (v: number) => void;
}) {
  const C = TONE[tone];
  return (
    <div className="mb-4">
      <div className="mb-1 flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="text-[13px] font-semibold text-text-primary">{title}</div>
          <div className="text-[11.5px] text-text-muted">{description}</div>
        </div>
        <span className="rounded-md px-2.5 py-1 text-[11.5px] font-bold"
          style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}` }}>
          {valueLabel}
        </span>
      </div>
      <input
        type="range"
        min={1}
        max={120}
        step={1}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="mt-2 h-1.5 w-full cursor-pointer appearance-none rounded-full"
        style={{
          background: `linear-gradient(to right, ${C.text} ${(value / 120) * 100}%, rgba(255,255,255,0.08) ${(value / 120) * 100}%)`,
          accentColor: C.text,
        }}
      />
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-text-muted">
        <span>1min</span>
        <span>60min</span>
        <span>120min</span>
      </div>
    </div>
  );
}
