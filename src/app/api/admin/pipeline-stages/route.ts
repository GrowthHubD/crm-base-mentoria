/**
 * Colunas do kanban.
 *
 *   GET    — lista, em ordem
 *   PUT    — salva o quadro inteiro (nome, cor, ordem, visibilidade)
 *   POST   — cria coluna personalizada
 *   DELETE — remove coluna personalizada (?id=...)
 *
 * LER é de todo mundo; ESCREVER é do dono.
 *
 * O GET precisa ser aberto a qualquer sessão porque as colunas são o quadro —
 * são as MESMAS para a instalação inteira. Com o GET sob `requireAdmin`, o
 * atendente tomava 403 e a tela caía no quadro de fábrica: ele via "Novos /
 * Prioridade / Urgência" enquanto o dono via o funil de quinze colunas, e o
 * card que ele arrastasse iria para uma coluna que não existe no quadro do
 * outro. Foi exatamente o que aconteceu.
 *
 * Escrever segue com `requireAdmin`: mexer nas colunas muda o quadro de TODO
 * mundo, inclusive de quem está com a tela aberta. É decisão de dono, não de
 * operação.
 *
 * O PUT recebe a lista completa porque posição é relativa — salvar coluna a
 * coluna criaria estados intermediários com duas na mesma posição.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin, requireSession } from '@/lib/auth-helpers';
import {
  listStages,
  replaceStages,
  resetStages,
  createCustomStage,
  deleteCustomStage,
  StageValidationError,
} from '@/modules/pipeline/stages';
import { logger } from '@/lib/logger';

/** Erro de preenchimento vai com o texto para a tela; o resto vira 500 mudo. */
function falha(err: unknown, contexto: string) {
  if (err instanceof StageValidationError) {
    // 400 com a mensagem: quem configurou precisa saber QUAL coluna está
    // errada, não "erro ao salvar".
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  logger.error({ err: err instanceof Error ? err.message : err }, `[pipeline-stages] ${contexto}`);
  return NextResponse.json({ error: 'Erro ao processar as colunas' }, { status: 500 });
}

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;
  try {
    return NextResponse.json({ stages: await listStages() });
  } catch (err) {
    return falha(err, 'GET');
  }
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdmin(req);
  if ('response' in guard) return guard.response;

  let body: { stages?: unknown; reset?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  try {
    if (body.reset === true) return NextResponse.json({ stages: await resetStages() });
    if (!Array.isArray(body.stages)) {
      return NextResponse.json({ error: 'Envie `stages` como lista' }, { status: 400 });
    }
    return NextResponse.json({ stages: await replaceStages(body.stages) });
  } catch (err) {
    return falha(err, 'PUT');
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if ('response' in guard) return guard.response;

  let body: { label?: unknown; color?: unknown; baseStatus?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  try {
    const stage = await createCustomStage({
      label: String(body.label ?? ''),
      color: String(body.color ?? ''),
      baseStatus: String(body.baseStatus ?? ''),
    });
    return NextResponse.json({ stage, stages: await listStages() }, { status: 201 });
  } catch (err) {
    return falha(err, 'POST');
  }
}

export async function DELETE(req: NextRequest) {
  const guard = await requireAdmin(req);
  if ('response' in guard) return guard.response;

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Informe o id da coluna' }, { status: 400 });

  try {
    const { leadsMovidos } = await deleteCustomStage(id);
    // Devolve quantos cards voltaram para a coluna de fábrica — a tela avisa,
    // para ninguém achar que os leads foram apagados junto.
    return NextResponse.json({ leadsMovidos, stages: await listStages() });
  } catch (err) {
    return falha(err, 'DELETE');
  }
}
