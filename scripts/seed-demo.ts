/**
 * Seed de DEMONSTRAÇÃO — popula o CRM com um cenário plausível.
 *
 * Para que serve: um CRM vazio não se apresenta. Kanban sem card, dashboard
 * zerado e chat em branco não mostram o produto. Este script cria leads em
 * todas as colunas do pipeline, com conversas reais e timestamps escalonados,
 * para a tela contar a história sozinha.
 *
 * NÃO é o seed de produção (`npm run db:seed`, que só cria os usuários).
 *
 * Idempotente: identifica o que criou por `externalContactId` com o prefixo
 * DEMO_PREFIX e regrava, então pode rodar quantas vezes quiser sem duplicar.
 *
 * Uso:
 *   npm run db:seed:demo            # cria/atualiza o cenário
 *   DEMO_RESET=1 npm run db:seed:demo   # apaga o cenário antes de recriar
 *
 * ⚠️ `DEMO_RESET` apaga SOMENTE os leads com o prefixo de demo e as mensagens
 * deles. Nunca toca em lead real.
 */
import 'dotenv/config';
import { and, eq, like } from 'drizzle-orm';
import { db } from '../src/lib/db/client';
import { leads, messages, connections, users } from '../src/lib/db/schema';

/** Todo contato de demo começa com isto — é o que torna o reset seguro. */
const DEMO_PREFIX = '5599000';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

type Turn = { from: 'lead' | 'ai' | 'human'; text: string; minutesAgo: number };

interface DemoLead {
  suffix: string;
  name: string;
  status: 'new' | 'priority' | 'urgency' | 'attending' | 'converted';
  attributedChannel: 'whatsapp' | 'instagram' | 'google' | null;
  /** Há quanto tempo o lead entrou, em horas. Alimenta o relógio do kanban. */
  ageHours: number;
  escalationLevel: number;
  turns: Turn[];
}

/**
 * Cenário: prestador de serviço genérico. Sem nicho — é o que o CRM Base
 * precisa demonstrar. Os textos evitam qualquer segmento específico.
 */
const SCENARIO: DemoLead[] = [
  {
    suffix: '001',
    name: 'Marina Alves',
    status: 'new',
    attributedChannel: 'instagram',
    ageHours: 0.2,
    escalationLevel: 0,
    turns: [
      { from: 'lead', text: 'Oi! Vi o anúncio de vocês no Instagram, ainda tem vaga pra essa semana?', minutesAgo: 12 },
    ],
  },
  {
    suffix: '002',
    name: 'Carlos Eduardo',
    status: 'priority',
    attributedChannel: 'google',
    ageHours: 3,
    escalationLevel: 1,
    turns: [
      { from: 'lead', text: 'Boa tarde, queria um orçamento', minutesAgo: 180 },
      { from: 'ai', text: 'Boa tarde, Carlos! Claro 😊 Me conta rapidinho o que você precisa que eu já te passo os valores.', minutesAgo: 179 },
      { from: 'lead', text: 'É pra uns 20 itens, mais ou menos', minutesAgo: 174 },
      { from: 'ai', text: 'Perfeito. Pra esse volume consigo fechar uma condição melhor. Você prefere que eu mande por aqui ou prefere falar com um consultor?', minutesAgo: 173 },
      { from: 'lead', text: 'Pode mandar por aqui mesmo', minutesAgo: 150 },
    ],
  },
  {
    suffix: '003',
    name: 'Juliana Prado',
    status: 'urgency',
    attributedChannel: 'whatsapp',
    ageHours: 26,
    escalationLevel: 2,
    turns: [
      { from: 'lead', text: 'Bom dia, alguém pode me atender?', minutesAgo: 1560 },
      { from: 'ai', text: 'Bom dia, Juliana! Estou aqui 😊 Como posso ajudar?', minutesAgo: 1559 },
      { from: 'lead', text: 'Fiz um pedido semana passada e ainda não recebi retorno', minutesAgo: 1550 },
      { from: 'ai', text: 'Sinto muito por isso. Vou chamar um colega pra olhar seu caso agora mesmo, um instante.', minutesAgo: 1549 },
      { from: 'lead', text: 'Por favor, já faz uma semana', minutesAgo: 120 },
    ],
  },
  {
    suffix: '004',
    name: 'Rafael Monteiro',
    status: 'attending',
    attributedChannel: 'instagram',
    ageHours: 5,
    escalationLevel: 0,
    turns: [
      { from: 'lead', text: 'Oi, tudo bem? Queria entender melhor como funciona', minutesAgo: 300 },
      { from: 'ai', text: 'Oi, Rafael! Tudo ótimo 😊 Funciona assim: você escolhe o plano, a gente agenda e cuida do resto. Quer que eu te mostre as opções?', minutesAgo: 299 },
      { from: 'lead', text: 'Quero sim', minutesAgo: 290 },
      { from: 'human', text: 'Rafael, aqui é a Bea da equipe. Acabei de te mandar as opções no seu e-mail também, dá uma olhada e me fala o que achou!', minutesAgo: 45 },
    ],
  },
  {
    suffix: '005',
    name: 'Patrícia Nunes',
    status: 'converted',
    attributedChannel: 'google',
    ageHours: 30,
    escalationLevel: 0,
    turns: [
      { from: 'lead', text: 'Achei vocês no Google, queria contratar', minutesAgo: 1800 },
      { from: 'ai', text: 'Que ótimo, Patrícia! Vou te passar os detalhes 😊', minutesAgo: 1799 },
      { from: 'lead', text: 'Fechado, pode mandar o link de pagamento', minutesAgo: 1700 },
      { from: 'human', text: 'Enviado! Assim que confirmar já deixo tudo agendado pra você 💚', minutesAgo: 1699 },
      { from: 'lead', text: 'Paguei agora, obrigada!', minutesAgo: 1650 },
    ],
  },
  {
    suffix: '006',
    name: 'Diego Fontes',
    status: 'new',
    attributedChannel: 'whatsapp',
    ageHours: 1.5,
    escalationLevel: 0,
    turns: [
      { from: 'lead', text: 'Vcs atendem no fim de semana?', minutesAgo: 90 },
      { from: 'ai', text: 'Oi, Diego! Atendemos sim, sábado até as 14h 😊 Quer que eu já reserve um horário?', minutesAgo: 89 },
    ],
  },
];

/** Conexão fake só pra tela de Conexões não ficar vazia na apresentação. */
async function ensureDemoConnection(): Promise<string> {
  const externalId = `demo-instance-${DEMO_PREFIX}`;
  const [existing] = await db
    .select()
    .from(connections)
    .where(eq(connections.externalId, externalId))
    .limit(1);

  if (existing) return existing.id;

  const [created] = await db
    .insert(connections)
    .values({
      type: 'whatsapp',
      status: 'connected',
      externalId,
      displayName: 'Atendimento (demo)',
      phoneNumber: '5511988887777',
      metadata: { demo: true },
    })
    .returning({ id: connections.id });

  return created.id;
}

async function resetDemo() {
  const demoLeads = await db
    .select({ id: leads.id })
    .from(leads)
    .where(like(leads.externalContactId, `${DEMO_PREFIX}%`));

  for (const lead of demoLeads) {
    await db.delete(messages).where(eq(messages.leadId, lead.id));
  }
  await db.delete(leads).where(like(leads.externalContactId, `${DEMO_PREFIX}%`));
  console.log(`  ↳ reset: ${demoLeads.length} leads de demo removidos`);
}

async function main() {
  console.log('\n═══════════════════════════════════════════');
  console.log('  SEED DE DEMONSTRAÇÃO');
  console.log('═══════════════════════════════════════════\n');

  if (process.env.DEMO_RESET === '1') await resetDemo();

  const connectionId = await ensureDemoConnection();

  // Atendente para assinar as mensagens humanas. Opcional: se o seed de
  // usuários não rodou, as mensagens ficam sem autor e nada quebra.
  const [attendant] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'attendant'))
    .limit(1);

  const now = Date.now();
  let created = 0;

  for (const demo of SCENARIO) {
    const externalContactId = `${DEMO_PREFIX}${demo.suffix}`;
    const lastTurn = demo.turns[demo.turns.length - 1];
    const lastInbound = [...demo.turns].reverse().find(t => t.from === 'lead');
    const lastOutbound = [...demo.turns].reverse().find(t => t.from !== 'lead');

    const [existing] = await db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.externalContactId, externalContactId), eq(leads.channel, 'whatsapp')))
      .limit(1);

    if (existing) {
      console.log(`  ↳ ${demo.name} já existe — pulando`);
      continue;
    }

    const createdAt = new Date(now - demo.ageHours * HOUR);
    const [lead] = await db
      .insert(leads)
      .values({
        externalContactId,
        channel: 'whatsapp',
        connectionId,
        name: demo.name,
        phone: externalContactId,
        status: demo.status,
        attributedChannel: demo.attributedChannel,
        escalationLevel: demo.escalationLevel,
        aiAgentActive: 1,
        lastMessageAt: new Date(now - lastTurn.minutesAgo * MIN),
        lastInboundAt: lastInbound ? new Date(now - lastInbound.minutesAgo * MIN) : null,
        lastOutboundAt: lastOutbound ? new Date(now - lastOutbound.minutesAgo * MIN) : null,
        statusChangedAt: createdAt,
        createdAt,
        updatedAt: createdAt,
        ...(demo.status === 'converted' ? { convertedAt: new Date(now - 27 * HOUR) } : {}),
      })
      .returning({ id: leads.id });

    for (const [i, turn] of demo.turns.entries()) {
      const at = new Date(now - turn.minutesAgo * MIN);
      await db.insert(messages).values({
        // Prefixo demo no external_id: mantém a unique key satisfeita e deixa
        // claro na tabela o que é cenário e o que é tráfego real.
        externalId: `demo-${externalContactId}-${i}`,
        leadId: lead.id,
        direction: turn.from === 'lead' ? 'inbound' : 'outbound',
        type: 'text',
        sender: turn.from,
        sentById: turn.from === 'human' ? attendant?.id ?? null : null,
        body: turn.text,
        senderName: turn.from === 'human' ? 'Bea' : null,
        status: 'sent',
        delivered: true,
        read: turn.from === 'lead',
        // `timestamp` é o que a UI do chat ordena; `createdAt` é auditoria.
        timestamp: at,
        createdAt: at,
      });
    }

    created++;
    console.log(`  ✓ ${demo.name} (${demo.status}) — ${demo.turns.length} mensagens`);
  }

  console.log(`\n${created} leads criados. Kanban, chat e dashboard já têm o que mostrar.\n`);
  process.exit(0);
}

main().catch(err => {
  console.error('Seed de demo falhou:', err);
  process.exit(1);
});
