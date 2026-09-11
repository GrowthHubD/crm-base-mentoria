'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Bot, Clock, Rows3, Bell, MessageSquare,
  CircleUser, ArrowLeftRight, CalendarClock, Save,
  Trash2, Loader2, Plus, Minus, AlertCircle, Radio,
  Sparkles, PauseCircle, PlayCircle, ShieldAlert,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import Card from '@/components/Card';
import Accordion from '@/components/Accordion';
import Toggle from '@/components/Toggle';
import type {
  AiAgentConfigPublic, AiAgentConfigInput,
  TransferRule, FollowupRule, AiAgentTone, ChannelKeywordRule,
} from '@/modules/ai-agent/types';

interface PreviewPrompt {
  system: string;
  user: string;
}

export default function AgenteIAPage() {
  const [config, setConfig] = useState<AiAgentConfigPublic | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewPrompt | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // Último `enabled` persistido — pra detectar transição OFF→ON no save e
  // oferecer religar a IA nos chats existentes.
  const [lastSavedEnabled, setLastSavedEnabled] = useState<boolean | null>(null);

  async function loadPreview() {
    setPreviewLoading(true);
    try {
      const r = await fetch('/api/admin/ai-config/preview', { cache: 'no-store' });
      if (r.ok) setPreview((await r.json()) as PreviewPrompt);
    } catch {
      // silent — preview é só auxiliar
    } finally {
      setPreviewLoading(false);
    }
  }

  // ── Load ────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [cfgRes, pvRes] = await Promise.all([
          fetch('/api/admin/ai-config', { cache: 'no-store' }),
          fetch('/api/admin/ai-config/preview', { cache: 'no-store' }),
        ]);
        if (!cfgRes.ok) throw new Error(`Config HTTP ${cfgRes.status}`);
        const cfgJson = (await cfgRes.json()) as { config: AiAgentConfigPublic };
        if (cancelled) return;
        setConfig(cfgJson.config);
        setLastSavedEnabled(cfgJson.config.enabled);
        if (pvRes.ok) setPreview((await pvRes.json()) as PreviewPrompt);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Erro carregando');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // ── Save ───────────────────────────────────────────────────────────
  async function handleSave() {
    if (!config || saving) return;

    const turningBackOn = lastSavedEnabled === false && config.enabled === true;
    let propagateToExistingLeads = false;
    if (turningBackOn) {
      propagateToExistingLeads = confirm(
        'IA está sendo religada.\n\n' +
          'Quer religar a IA também em TODOS os chats existentes que ficaram com IA desativada enquanto o toggle global estava off?\n\n' +
          '• Nada é enviado agora — a IA só responde quando o lead mandar nova mensagem.\n' +
          '• Leads marcados como "Convertido" ou "Perdido" não são afetados.'
      );
    }

    setSaving(true);
    setError(null);
    try {
      const payload: AiAgentConfigInput & { propagateToExistingLeads?: boolean } = {
        enabled: config.enabled,
        systemPrompt: config.systemPrompt,
        supportSystemPrompt: config.supportSystemPrompt,
        temperature: config.temperature,
        maxMessagesBeforeHandoff: config.maxMessagesBeforeHandoff,
        agentName: config.agentName,
        personality: config.personality,
        tone: config.tone,
        useEmojis: config.useEmojis,
        welcomeMessage: config.welcomeMessage,
        transferMessage: config.transferMessage,
        idleSecondsBeforeAi: config.idleSecondsBeforeAi,
        idleMinutesUser: config.idleMinutesUser,
        typingMsPerChar: config.typingMsPerChar,
        blockSendEnabled: config.blockSendEnabled,
        blockSendDelaySec: config.blockSendDelaySec,
        followups: config.followups,
        channelKeywords: config.channelKeywords,
        transferRules: config.transferRules,
        operationHoursText: config.operationHoursText,
        aiPauseMinutesAfterHuman: config.aiPauseMinutesAfterHuman,
        aiPauseMinutesAfterCancellation: config.aiPauseMinutesAfterCancellation,
        ...(propagateToExistingLeads ? { propagateToExistingLeads: true } : {}),
      };
      const res = await fetch('/api/admin/ai-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error((errBody as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        config: AiAgentConfigPublic;
        propagated?: { affected: number };
      };
      setConfig(json.config);
      setLastSavedEnabled(json.config.enabled);
      const stamp = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      setSavedAt(
        json.propagated
          ? `${stamp} — IA religada em ${json.propagated.affected} chat${json.propagated.affected === 1 ? '' : 's'}`
          : stamp
      );
      loadPreview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro salvando');
    } finally {
      setSaving(false);
    }
  }

  function patch<K extends keyof AiAgentConfigPublic>(k: K, v: AiAgentConfigPublic[K]) {
    setConfig(c => (c ? { ...c, [k]: v } : c));
  }

  /** Pausa de emergência da IA. minutes=0 = indefinida. */
  async function pauseUnit(minutes: number) {
    if (saving) return;
    const label = minutes === 0 ? 'indefinida' : `${minutes} min`;
    if (!confirm(
      `Pausar a IA por ${label}?\n\n` +
        `• Nenhuma mensagem da IA vai sair (resposta ou follow-up).\n` +
        `• Follow-ups pendentes serão CANCELADOS de imediato.\n` +
        `• Atendentes humanos continuam respondendo normalmente.`
    )) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/ai-config/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const j = await res.json();
      setConfig(j.config);
      alert(`IA pausada. ${j.cancelledFollowups} follow-up(s) cancelado(s).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
    } finally {
      setSaving(false);
    }
  }

  async function resumeUnit() {
    if (saving) return;
    if (!confirm('Retomar a IA agora?')) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/ai-config/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ until: null }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const j = await res.json();
      setConfig(j.config);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
    } finally {
      setSaving(false);
    }
  }

  function patchFollowup(idx: number, p: Partial<FollowupRule>) {
    setConfig(c => {
      if (!c) return c;
      const list = [...c.followups];
      const cur = list[idx] ?? { enabled: false, afterMinutes: 30, instruction: '' };
      list[idx] = { ...cur, ...p };
      return { ...c, followups: list };
    });
  }

  function patchChannelKeyword(idx: number, p: Partial<ChannelKeywordRule>) {
    setConfig(c => {
      if (!c) return c;
      const list = [...c.channelKeywords];
      const cur = list[idx] ?? { keyword: '', channel: 'whatsapp' as const };
      list[idx] = { ...cur, ...p };
      return { ...c, channelKeywords: list };
    });
  }
  function addChannelKeyword() {
    setConfig(c => c ? { ...c, channelKeywords: [...c.channelKeywords, { keyword: '', channel: 'whatsapp' }] } : c);
  }
  function removeChannelKeyword(idx: number) {
    setConfig(c => c ? { ...c, channelKeywords: c.channelKeywords.filter((_, i) => i !== idx) } : c);
  }

  function patchTransferRule(idx: number, p: Partial<TransferRule>) {
    setConfig(c => {
      if (!c) return c;
      const list = [...c.transferRules];
      const cur = list[idx];
      if (!cur) return c;
      list[idx] = { ...cur, ...p };
      return { ...c, transferRules: list };
    });
  }

  // ── Render ──────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex h-[calc(100vh-64px)] items-center justify-center">
        <Loader2 className="animate-spin text-text-muted" size={28} strokeWidth={1.6} />
      </div>
    );
  }

  if (!config) {
    return (
      <div className="flex h-[calc(100vh-64px)] flex-col items-center justify-center gap-3">
        <AlertCircle size={32} strokeWidth={1.4} className="text-text-muted" />
        <div className="text-text-muted">{error ?? 'Config indisponível'}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <PageHeader
        icon={<Bot size={18} strokeWidth={1.6} />}
        title="Configurações do Agente IA"
        subtitle="Personalize o comportamento do assistente"
      />

      <div className="px-3 py-4 pb-24 md:px-6 md:py-6">
        {error && (
          <div className="mb-4 rounded-md px-3 py-2 text-[12px]"
            style={{ background: 'rgba(248,113,113,0.08)', color: '#F87171' }}>
            {error}
          </div>
        )}

        {/* PARAR A IA — botão de emergência */}
        <EmergencyPauseCard
          pausedUntil={config.pausedUntil}
          onPause={pauseUnit}
          onResume={resumeUnit}
        />

        {/* Toggle principal */}
        <div className="relative mb-6">
          <Card padding={20}
            style={config.enabled
              ? { boxShadow: 'inset 0 0 0 1px rgba(var(--accent-mid-rgb),0.25), 0 0 40px rgba(var(--accent-mid-rgb),0.08)' }
              : undefined}
          >
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div
                  className="flex h-12 w-12 items-center justify-center rounded-xl"
                  style={{
                    background: config.enabled ? 'rgba(var(--accent-mid-rgb),0.15)' : 'rgba(148,163,184,0.08)',
                    color: config.enabled ? 'var(--accent-light)' : '#64748B',
                    transition: 'all 200ms ease',
                  }}
                >
                  <Bot size={22} strokeWidth={1.6} />
                </div>
                <div>
                  <div className="text-[15px] font-semibold text-text-primary">{config.agentName}</div>
                  <div className="mt-0.5 text-[12.5px] text-text-secondary">
                    {config.enabled ? 'Agente ativo — responde leads automaticamente' : 'Agente pausado'}
                  </div>
                </div>
              </div>
              <Toggle size="lg" checked={config.enabled} onChange={v => patch('enabled', v)} />
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-3">
          {/* PERSONALIDADE */}
          <Accordion
            icon={<CircleUser size={18} strokeWidth={1.6} />}
            title="Personalidade & Tom"
            description="Como a IA se apresenta e fala com os clientes"
            defaultOpen
          >
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Nome do agente" value={config.agentName} onChange={v => patch('agentName', v)} />
              <div>
                <div className="section-label mb-2">Tom da conversa</div>
                <div className="flex gap-1.5">
                  {(['formal', 'friendly', 'casual'] as AiAgentTone[]).map(t => {
                    const isSel = config.tone === t;
                    const labels = { formal: '🎩 Formal', friendly: '😊 Amigável', casual: '😄 Descontraído' };
                    return (
                      <button key={t}
                        onClick={() => patch('tone', t)}
                        className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[12px] transition-all duration-150 ${
                          isSel ? 'text-white' : 'text-text-muted hover:text-text-secondary'
                        }`}
                        style={isSel
                          ? { background: 'var(--accent)', boxShadow: '0 0 12px rgba(var(--accent-mid-rgb),0.35)' }
                          : { background: '#18181F', border: '1px solid var(--border-subtle)' }}>
                        {labels[t]}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <div className="mt-4">
              <TextArea
                label="Personalidade (opcional)"
                value={config.personality ?? ''}
                onChange={v => patch('personality', v || null)}
                hint='Ex: "Cordial, ágil e focado em ajudar o cliente."'
                rows={2}
              />
            </div>
            <div className="mt-4 pt-4" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <ToggleRow title="Usar emojis nas respostas" desc="Torna a conversa mais leve e humana"
                checked={config.useEmojis} onChange={v => patch('useEmojis', v)} />
            </div>
            <div className="mt-4">
              <TextArea
                label="System prompt customizado (avançado, opcional)"
                value={config.systemPrompt ?? ''}
                onChange={v => patch('systemPrompt', v || null)}
                hint="Se preenchido (>20 chars), substitui o template default. Deixe vazio pra usar o template gerado a partir dos campos acima."
                rows={4}
              />
            </div>
            <div className="mt-4 rounded-xl border p-3"
              style={{ background: 'rgba(167,139,250,0.06)', borderColor: 'rgba(167,139,250,0.25)' }}>
              <div className="mb-1.5 flex items-center gap-2 text-[12px] font-semibold" style={{ color: '#A78BFA' }}>
                <Bot size={13} strokeWidth={1.7} />
                Prompt do Suporte IA (atendentes)
              </div>
              <p className="mb-2 text-[11.5px] text-text-muted leading-relaxed">
                Esse prompt orienta a IA que dá sugestões pros ATENDENTES dentro do CRM (aba &ldquo;Suporte IA&rdquo; na conversa).
                Diferente do prompt acima que fala com o cliente, esse responde EM 1ª PESSOA pro atendente. Deixe vazio
                pra usar o template embutido.
              </p>
              <TextArea
                label=""
                value={config.supportSystemPrompt ?? ''}
                onChange={v => patch('supportSystemPrompt', v || null)}
                hint='Variável disponível: {{businessName}}. Recomendado manter as "REGRAS DE OURO" do default.'
                rows={6}
              />
            </div>
          </Accordion>

          {/* MENSAGENS PRONTAS */}
          <Accordion
            icon={<MessageSquare size={18} strokeWidth={1.6} className="text-success-text" />}
            title="Mensagens Automáticas"
            description="Saudação inicial e transferência"
          >
            <div className="grid gap-4">
              <TextArea label="Saudação inicial (welcome)"
                value={config.welcomeMessage ?? ''}
                onChange={v => patch('welcomeMessage', v || null)}
                rows={2}
              />
              <TextArea label="Mensagem ao transferir pra humano"
                value={config.transferMessage}
                onChange={v => patch('transferMessage', v)}
                rows={2}
              />
            </div>
          </Accordion>

          {/* TIMING */}
          <Accordion
            icon={<Clock size={18} strokeWidth={1.6} />}
            title="Timing & Comportamento"
            description="Quando a IA assume e quando transfere"
          >
            <div className="grid gap-4 md:grid-cols-2">
              <Stepper
                label="IA assume após X sem resposta humana"
                value={config.idleSecondsBeforeAi}
                onChange={v => patch('idleSecondsBeforeAi', v)}
                suffix="seg" min={0} max={3600} step={30}
                hint="0 = IA responde direto. >0 = lead fica em fila por X segundos; se nenhum atendente humano responder nesse tempo, a IA assume. O relógio reseta a cada nova mensagem do lead E quando o atendente humano responde."
              />
              <Stepper
                label="Velocidade de digitação"
                value={config.typingMsPerChar}
                onChange={v => patch('typingMsPerChar', v)}
                suffix="ms/char" min={0} max={200} step={5}
                hint='Quanto tempo o WhatsApp mostra "digitando..." antes de cada balão — ms por caractere. Default 35.'
              />
              <Stepper
                label="Ociosidade do cliente (reclassificar)"
                value={config.idleMinutesUser}
                onChange={v => patch('idleMinutesUser', v)}
                suffix="min" min={1} max={1440}
              />
              <Stepper
                label="Máximo de respostas da IA antes de transferir"
                value={config.maxMessagesBeforeHandoff}
                onChange={v => patch('maxMessagesBeforeHandoff', v)}
                suffix="msgs" min={1} max={50}
              />
              <Stepper
                label="Temperatura (criatividade)"
                value={config.temperature}
                onChange={v => patch('temperature', v)}
                suffix="/100" min={0} max={100} step={5}
                hint="0 = determinístico, 100 = mais criativo. Default 70."
              />
              <Stepper
                label="IA cala após atendente humano falar"
                value={config.aiPauseMinutesAfterHuman}
                onChange={v => patch('aiPauseMinutesAfterHuman', v)}
                suffix="min" min={0} max={1440}
                hint="Cada mensagem do atendente humano renova esse timer. Impede que IA e humano falem juntos. Default 20."
              />
              <Stepper
                label="IA cala após transferir"
                value={config.aiPauseMinutesAfterCancellation}
                onChange={v => patch('aiPauseMinutesAfterCancellation', v)}
                suffix="min" min={0} max={1440}
                hint='Quando a IA decide transferir, ela cala por esses minutos pro atendente humano assumir. Default 20.'
              />
            </div>
          </Accordion>

          {/* ENVIO EM BLOCOS */}
          <Accordion
            icon={<Rows3 size={18} strokeWidth={1.6} />}
            title="Envio em Blocos"
            description="Quebra respostas longas em mensagens menores"
          >
            <ToggleRow title="Ativar envio em blocos"
              desc="A IA divide mensagens longas em partes e envia com pausa."
              checked={config.blockSendEnabled}
              onChange={v => patch('blockSendEnabled', v)} />
            <div className="mt-4">
              <Stepper
                label="Delay entre blocos"
                value={config.blockSendDelaySec}
                onChange={v => patch('blockSendDelaySec', v)}
                suffix="seg" min={0} max={30}
                hint="Pausa extra entre balões. Recomendado 1 a 2s."
              />
            </div>
          </Accordion>

          {/* FOLLOW-UPS */}
          <Accordion
            icon={<Bell size={18} strokeWidth={1.6} />}
            title="Follow-ups Automáticos"
            description="Mensagens que a IA gera quando o cliente fica sem responder"
          >
            <p className="mb-4 text-[12.5px] text-text-secondary">
              A IA dispara até 4 follow-ups depois que <strong>vocês</strong> mandaram a última mensagem e o cliente sumiu.
              Pra cada um, você define a <strong>diretriz</strong> e a IA escreve a mensagem na hora, baseada na conversa.
            </p>
            <div className="flex flex-col gap-3">
              {[0, 1, 2, 3].map(idx => {
                const defaults = [5, 15, 30, 60];
                const placeholders = [
                  'Ex: lembrete leve, pergunte se ainda há interesse',
                  'Ex: ofereça ajuda pra tirar dúvidas que possam estar travando a decisão',
                  'Ex: último contato leve pra retomar a conversa',
                  'Ex: encerramento cordial, deixe claro que ficamos à disposição',
                ];
                const raw = config.followups[idx];
                const fu: FollowupRule = raw ?? { enabled: false, afterMinutes: defaults[idx] ?? 60, instruction: '' };
                const currentText = fu.instruction ?? fu.message ?? '';
                return (
                  <div key={idx} className="rounded-xl p-4"
                    style={{ background: '#18181F', border: '1px solid var(--border-subtle)' }}>
                    <div className="mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold"
                          style={{ background: 'rgba(var(--accent-mid-rgb),0.15)', color: 'var(--accent-light)' }}>{idx + 1}</span>
                        <span className="text-[13px] font-semibold text-text-primary">Follow-up {idx + 1}</span>
                      </div>
                      <Toggle checked={fu.enabled} onChange={v => patchFollowup(idx, { enabled: v })} />
                    </div>
                    <div className="mb-3">
                      <Stepper label="Disparar após"
                        value={fu.afterMinutes}
                        onChange={v => patchFollowup(idx, { afterMinutes: v })}
                        suffix="min" min={1} max={1440}
                      />
                    </div>
                    <TextArea label="Diretriz pra IA"
                      value={currentText}
                      onChange={v => patchFollowup(idx, { instruction: v, message: undefined })}
                      rows={2}
                      placeholder={placeholders[idx]}
                    />
                    <p className="mt-1 text-[11px] text-text-muted">
                      Não escreva a mensagem pronta — escreva o <strong>objetivo</strong>. A IA usa a conversa pra montar o texto.
                    </p>
                  </div>
                );
              })}
            </div>
          </Accordion>

          {/* ATRIBUIÇÃO DE CANAL POR PALAVRA-CHAVE */}
          <Accordion
            icon={<Radio size={18} strokeWidth={1.6} />}
            title="Atribuição de Canal por Palavra-chave"
            description="Detecta a origem do lead a partir do conteúdo da conversa"
          >
            <p className="mb-2 text-[12.5px] text-text-secondary">
              Marcadores SEMPRE entre chaves <code className="rounded bg-[#18181F] px-1 py-0.5 text-[11.5px]">{'{1}'}</code>, <code className="rounded bg-[#18181F] px-1 py-0.5 text-[11.5px]">{'{ig}'}</code>, <code className="rounded bg-[#18181F] px-1 py-0.5 text-[11.5px]">{'{fb}'}</code>… podem aparecer em qualquer lugar da mensagem.
            </p>
            <p className="mb-4 text-[12px] text-text-muted">
              A cada nova mensagem do lead o sistema verifica a mais recente E procura retroativamente nas últimas 50 mensagens dele.
              Leads que nunca tiverem marcador não entram na dashboard de canais.
            </p>
            <div className="flex flex-col gap-2">
              {config.channelKeywords.map((rule, idx) => (
                <div key={idx} className="grid items-center gap-2"
                  style={{ gridTemplateColumns: '1fr 200px 32px' }}>
                  <input
                    value={rule.keyword}
                    onChange={e => patchChannelKeyword(idx, { keyword: e.target.value })}
                    placeholder='ex: 1, ig, fb, anuncio_x'
                    className="rounded-md border px-2.5 py-1.5 text-[12.5px] text-text-primary placeholder:text-text-muted focus:border-blue-light focus:outline-none"
                    style={{ background: '#18181F', borderColor: 'var(--border-subtle)' }}
                  />
                  <select
                    value={rule.channel}
                    onChange={e => patchChannelKeyword(idx, { channel: e.target.value as ChannelKeywordRule['channel'] })}
                    className="rounded-md border px-2.5 py-1.5 text-[12.5px] text-text-primary focus:border-blue-light focus:outline-none"
                    style={{ background: '#18181F', borderColor: 'var(--border-subtle)' }}
                  >
                    <option value="whatsapp">WhatsApp</option>
                    <option value="instagram">Instagram</option>
                    <option value="google">Google Ads</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => removeChannelKeyword(idx)}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-[rgba(248,113,113,0.08)] hover:text-error-text"
                    title="Remover"
                    aria-label="Remover"
                  >
                    <Trash2 size={13} strokeWidth={1.7} />
                  </button>
                </div>
              ))}
              {config.channelKeywords.length === 0 && (
                <div className="rounded-md border border-dashed py-4 text-center text-[12px] text-text-muted"
                  style={{ borderColor: 'var(--border-subtle)' }}>
                  Nenhuma regra configurada — nenhum lead vai aparecer na dashboard de canais.
                </div>
              )}
              <button
                type="button"
                onClick={addChannelKeyword}
                className="mt-1 flex items-center justify-center gap-2 rounded-md border border-dashed py-2 text-[12px] text-text-muted hover:bg-[rgba(var(--accent-light-rgb),0.05)] hover:text-blue-light"
                style={{ borderColor: 'var(--border-subtle)' }}
              >
                <Plus size={12} strokeWidth={1.8} /> Adicionar regra
              </button>
            </div>
            <ReapplyKeywordsButton hasRules={config.channelKeywords.length > 0} />
          </Accordion>

          {/* TRANSFER RULES */}
          <Accordion
            icon={<ArrowLeftRight size={18} strokeWidth={1.6} style={{ color: '#FBBF24' }} />}
            title="Regras de Transferência para Atendente"
            description="Quando a IA deve passar a conversa pra humano"
          >
            <p className="mb-4 text-[12.5px] text-text-secondary">
              A IA é instruída a aplicar essas regras. As habilitadas aparecem no prompt; as desabilitadas, não.
            </p>
            <div className="flex flex-col gap-3">
              {config.transferRules.map((r, idx) => (
                <div key={r.key} className="flex items-center gap-4 rounded-xl p-3.5"
                  style={{ background: '#18181F', border: '1px solid var(--border-subtle)' }}>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold text-text-primary">{r.label}</div>
                    {r.description && <div className="mt-0.5 text-[11.5px] text-text-muted">{r.description}</div>}
                  </div>
                  <Toggle checked={r.enabled} onChange={v => patchTransferRule(idx, { enabled: v })} />
                </div>
              ))}
              {config.transferRules.length === 0 && (
                <div className="text-[12px] text-text-muted italic">Nenhuma regra configurada — usando defaults internos.</div>
              )}
            </div>
          </Accordion>

          {/* HORÁRIO */}
          <Accordion
            icon={<CalendarClock size={18} strokeWidth={1.6} />}
            title="Horário de Atendimento"
            description="Informado ao cliente no prompt"
          >
            <TextArea label="Horário (texto livre)"
              value={config.operationHoursText ?? ''}
              onChange={v => patch('operationHoursText', v || null)}
              hint='Ex: "Seg-Sex 8h-22h, Sáb-Dom 10h-00h". Informativo — a IA menciona ao cliente quando fizer sentido.'
              rows={2}
            />
          </Accordion>

          {/* PROMPT EFETIVO (preview) */}
          <Accordion
            icon={<Bot size={18} strokeWidth={1.6} />}
            title="Prompt efetivo do agente"
            description="Veja o template completo que vai pro LLM (gerado a partir das configurações acima)"
          >
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <button
                onClick={loadPreview}
                disabled={previewLoading}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-transparent px-2.5 py-1 text-[11.5px] text-text-secondary hover:bg-white/5 disabled:opacity-50"
              >
                {previewLoading ? <Loader2 size={12} className="animate-spin" /> : '⟳'} Atualizar preview
              </button>
              <span className="text-[11px] text-text-muted">
                Reflete a config <strong>salva</strong>. Salve mudanças e clique &quot;Atualizar preview&quot; pra ver o resultado.
              </span>
            </div>
            {preview ? (
              <>
                <div className="mb-1.5 text-[12px] text-text-secondary">SYSTEM PROMPT</div>
                <pre className="mb-4 max-h-[420px] overflow-auto rounded-lg border p-3 text-[11px] leading-relaxed text-text-secondary whitespace-pre-wrap"
                  style={{ background: '#0B0B10', borderColor: 'var(--border-subtle)', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>
                  {preview.system}
                </pre>
                <div className="mb-1.5 text-[12px] text-text-secondary">USER MESSAGE (template enviado a cada turno)</div>
                <pre className="max-h-[180px] overflow-auto rounded-lg border p-3 text-[11px] leading-relaxed text-text-secondary whitespace-pre-wrap"
                  style={{ background: '#0B0B10', borderColor: 'var(--border-subtle)', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>
                  {preview.user}
                </pre>
              </>
            ) : (
              <div className="rounded-lg border border-dashed py-8 text-center text-[12px] text-text-muted"
                style={{ borderColor: 'var(--border-subtle)' }}>
                Clique em &quot;Atualizar preview&quot; pra ver o prompt compilado.
              </div>
            )}
          </Accordion>
        </div>

        {/* SAVE BAR */}
        <div className="mt-8 flex flex-col items-stretch gap-3">
          <button onClick={handleSave} disabled={saving}
            className="btn-primary w-full py-3 text-[14px] disabled:opacity-50 disabled:cursor-not-allowed">
            {saving ? <Loader2 size={16} strokeWidth={1.8} className="animate-spin" /> : <Save size={16} strokeWidth={1.8} />}
            {saving ? 'Salvando…' : 'Salvar Configurações'}
          </button>
          <div className="text-center text-[11px] text-text-muted">
            {savedAt ? `Salvo às ${savedAt}` : 'Faça alterações e clique em salvar'}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// UI building blocks (controlled)
// ─────────────────────────────────────────────────────────────────────

function Stepper({
  label, value, onChange, suffix, hint, min = 0, max = 999, step = 1,
}: {
  label: string; value: number; onChange: (v: number) => void;
  suffix?: string; hint?: string; min?: number; max?: number; step?: number;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const bump = (d: number) => onChange(clamp(value + d * step));
  const acme = useMemo(() => clamp(value), [value, min, max]);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const startEditing = () => {
    setDraft(String(acme));
    setEditing(true);
  };
  const commit = () => {
    const parsed = parseInt(draft, 10);
    if (Number.isFinite(parsed)) onChange(clamp(parsed));
    setEditing(false);
  };
  const cancel = () => setEditing(false);

  return (
    <div>
      <div className="mb-1.5 text-[12px] text-text-secondary">{label}</div>
      <div className="inline-flex overflow-hidden rounded-lg border"
        style={{ borderColor: 'var(--border-subtle)', background: '#1C1C28' }}>
        <button onClick={() => bump(-1)} type="button"
          className="flex h-9 w-9 items-center justify-center text-text-muted transition-colors hover:bg-[rgba(var(--accent-mid-rgb),0.1)] hover:text-blue-light">
          <Minus size={13} strokeWidth={2} />
        </button>
        {editing ? (
          <div className="flex h-9 min-w-[80px] items-center justify-center gap-1 px-2">
            <input
              autoFocus
              type="number"
              inputMode="numeric"
              value={draft}
              min={min}
              max={max}
              step={step}
              onChange={e => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
              }}
              onFocus={e => e.currentTarget.select()}
              className="w-14 bg-transparent text-center text-[13px] font-semibold text-text-primary tabular-nums focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            {suffix && <span className="text-[13px] font-semibold text-text-primary">{suffix}</span>}
          </div>
        ) : (
          <button
            type="button"
            onClick={startEditing}
            title="Clique para editar"
            className="flex h-9 min-w-[80px] items-center justify-center px-3 text-[13px] font-semibold text-text-primary tabular-nums transition-colors hover:bg-[rgba(var(--accent-mid-rgb),0.06)] hover:text-blue-light"
          >
            {acme} {suffix}
          </button>
        )}
        <button onClick={() => bump(1)} type="button"
          className="flex h-9 w-9 items-center justify-center text-text-muted transition-colors hover:bg-[rgba(var(--accent-mid-rgb),0.1)] hover:text-blue-light">
          <Plus size={13} strokeWidth={2} />
        </button>
      </div>
      {hint && <div className="mt-1.5 text-[11px] italic text-text-muted">{hint}</div>}
    </div>
  );
}

function ToggleRow({
  title, desc, checked, onChange,
}: {
  title: string; desc: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl p-3"
      style={{ background: '#18181F', border: '1px solid var(--border-subtle)' }}>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-text-primary">{title}</div>
        <div className="text-[11.5px] text-text-muted">{desc}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

function TextArea({
  label, value, onChange, rows = 3, hint, placeholder,
}: {
  label: string; value: string; onChange: (v: string) => void; rows?: number; hint?: string; placeholder?: string;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[12px] text-text-secondary">{label}</div>
      <textarea value={value} onChange={e => onChange(e.target.value)} rows={rows}
        placeholder={placeholder}
        className="w-full resize-none rounded-lg border bg-[#111116] p-3 text-[12.5px] leading-relaxed text-text-primary placeholder:text-text-muted focus:border-blue-light focus:outline-none"
        style={{ borderColor: 'var(--border-subtle)' }}
      />
      {hint && <div className="mt-1 text-[11px] italic text-text-muted">{hint}</div>}
    </div>
  );
}

function Field({
  label, value, onChange,
}: {
  label: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[12px] text-text-secondary">{label}</div>
      <input value={value} onChange={e => onChange(e.target.value)}
        className="w-full rounded-lg border bg-[#111116] px-3 py-2 text-[12.5px] text-text-primary focus:border-blue-light focus:outline-none"
        style={{ borderColor: 'var(--border-subtle)' }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// EmergencyPauseCard — botão grande pra PARAR A IA.
// Efeito imediato + cancela follow-ups pendentes.
// ─────────────────────────────────────────────────────────────────────
function EmergencyPauseCard({
  pausedUntil,
  onPause,
  onResume,
}: {
  pausedUntil: Date | string | null;
  onPause: (minutes: number) => void;
  onResume: () => void;
}) {
  const until = pausedUntil ? new Date(pausedUntil) : null;
  const isPaused = !!until && until.getTime() > Date.now();
  const isIndefinite = isPaused && until!.getTime() - Date.now() > 365 * 24 * 60 * 60 * 1000;

  if (isPaused) {
    return (
      <div className="relative mb-6 rounded-2xl p-5"
        style={{
          background: 'linear-gradient(135deg, rgba(248,113,113,0.16), rgba(248,113,113,0.06))',
          border: '1px solid rgba(248,113,113,0.45)',
          boxShadow: '0 0 30px rgba(248,113,113,0.12)',
        }}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl"
              style={{ background: 'rgba(248,113,113,0.2)', color: '#F87171' }}>
              <PauseCircle size={22} strokeWidth={1.7} />
            </div>
            <div>
              <div className="text-[14px] font-semibold" style={{ color: '#F87171' }}>
                IA PAUSADA — não responde nem dispara follow-up
              </div>
              <div className="mt-0.5 text-[12px] text-text-secondary">
                {isIndefinite
                  ? 'Pausa indefinida — só retoma quando você clicar em "Retomar IA".'
                  : `Retoma automaticamente em ${until!.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}.`}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onResume}
            className="flex items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px] font-semibold text-success-text hover:bg-[rgba(74,222,128,0.1)]"
            style={{ borderColor: 'rgba(74,222,128,0.45)', background: 'rgba(74,222,128,0.08)' }}>
            <PlayCircle size={14} strokeWidth={1.8} />
            Retomar IA
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative mb-6 rounded-2xl p-4"
      style={{
        background: '#15151B',
        border: '1px solid rgba(248,113,113,0.25)',
      }}>
      <div className="mb-3 flex items-center gap-2.5">
        <ShieldAlert size={16} strokeWidth={1.7} style={{ color: '#F87171' }} />
        <div>
          <div className="text-[13px] font-semibold" style={{ color: '#F87171' }}>
            Parar a IA (emergência)
          </div>
          <div className="text-[11.5px] text-text-muted">
            Para de vez sem precisar desconectar o número. Cancela todos os follow-ups pendentes.
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <PauseButton label="15 min" minutes={15} onClick={onPause} />
        <PauseButton label="1 hora" minutes={60} onClick={onPause} />
        <PauseButton label="4 horas" minutes={240} onClick={onPause} />
        <PauseButton label="Até eu reativar" minutes={0} onClick={onPause} strong />
      </div>
    </div>
  );
}

function PauseButton({
  label, minutes, onClick, strong = false,
}: {
  label: string; minutes: number; onClick: (m: number) => void; strong?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(minutes)}
      className="rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition-all hover:-translate-y-[1px]"
      style={strong
        ? { background: 'rgba(248,113,113,0.18)', borderColor: 'rgba(248,113,113,0.55)', color: '#F87171' }
        : { background: '#18181F', borderColor: 'rgba(248,113,113,0.35)', color: '#F87171' }}>
      {label}
    </button>
  );
}

/**
 * Botão "Aplicar nas conversas existentes" — chama o endpoint que roda
 * reevaluateChannelAttribution em todos os leads. Útil quando o admin adiciona
 * uma keyword nova e quer pegar marcadores que já vieram em msgs antigas.
 */
function ReapplyKeywordsButton({ hasRules }: { hasRules: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ total: number; updated: number; capped?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    if (!confirm(
      'Aplicar as regras de palavra-chave RETROATIVAMENTE em todas as conversas?\n\n' +
        '• Cada lead tem o histórico recente analisado pelas regras atuais.\n' +
        '• Se uma msg antiga tem o marcador (ex: "{1}"), o lead recebe o canal correto agora.\n' +
        '• Operação pode demorar 10-60s dependendo do volume de conversas.'
    )) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const res = await fetch('/api/admin/channel-keywords/reapply', { method: 'POST' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setResult({ total: j.total, updated: j.updated, capped: j.capped });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
    } finally {
      setBusy(false);
    }
  }

  if (!hasRules) return null;

  return (
    <div className="mt-4 rounded-lg border border-dashed p-3"
      style={{ borderColor: 'rgba(167,139,250,0.35)', background: 'rgba(167,139,250,0.04)' }}>
      <div className="mb-1.5 text-[12px] font-semibold text-text-primary">Aplicar nas conversas existentes</div>
      <p className="mb-2 text-[11.5px] leading-relaxed text-text-secondary">
        Hoje as regras só pegam mensagens NOVAS. Use esse botão pra varrer todos os leads
        e reatribuir canal usando o histórico.
      </p>
      <button onClick={run} disabled={busy}
        className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-[12px] font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ borderColor: 'rgba(167,139,250,0.4)', background: '#15151B', color: '#A78BFA' }}>
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} strokeWidth={1.8} />}
        {busy ? 'Reaplicando…' : 'Aplicar retroativamente'}
      </button>
      {result && (
        <div className="mt-2 text-[11.5px] text-success-text">
          ✓ {result.updated} de {result.total} {result.total === 1 ? 'lead atualizado' : 'leads atualizados'}
          {result.capped && ' (limite de 5000 atingido — rode de novo se necessário)'}
        </div>
      )}
      {error && (
        <div className="mt-2 text-[11.5px] text-error-text">Erro: {error}</div>
      )}
    </div>
  );
}
