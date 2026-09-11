'use client';

/**
 * Página de Configurações do gerente.
 *
 * Serve como hub de atalhos para as áreas configuráveis do CRM: Agente IA,
 * Conexões, Textos rápidos e gestão de Usuários.
 */
import Link from 'next/link';
import { Settings, Bot, Wifi, ArrowRight, Zap, Users, Columns3, Mail } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import Card from '@/components/Card';
import { readPlanFeatures } from '@/lib/plan';

interface ShortcutCardProps {
  href: string;
  icon: React.ReactNode;
  title: string;
  description: string;
}

function ShortcutCard({ href, icon, title, description }: ShortcutCardProps) {
  return (
    <Link href={href} className="block">
      <Card padding={20} className="transition-colors hover:bg-white/3">
        <div className="flex items-start gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
            style={{ background: 'rgba(var(--accent-light-rgb),0.12)', color: 'var(--accent-light)' }}
          >
            {icon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[14px] font-semibold text-text-primary">{title}</h3>
              <ArrowRight size={14} className="text-text-muted" />
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-text-secondary">{description}</p>
          </div>
        </div>
      </Card>
    </Link>
  );
}

/**
 * Hub de atalhos. Os cards passam pelo MESMO filtro de plano da navegação —
 * sem isto, o cliente que paga só o CRM via "Agente IA" aqui e clicava num
 * módulo que não comprou. Esconder no menu e deixar na tela de configurações
 * é esconder pela metade.
 */
export default function ConfiguracoesPage() {
  const features = readPlanFeatures();
  return (
    <div className="flex flex-col">
      <PageHeader
        icon={<Settings size={18} strokeWidth={1.6} />}
        title="Configurações"
        subtitle="Atalhos para configurar o atendimento"
      />

      <div className="max-w-3xl px-3 py-4 pb-24 md:px-6 md:py-6">
        <div className="grid gap-4 md:grid-cols-2">
          {features.aiAgent && (
            <ShortcutCard
              href="/agente-ia"
              icon={<Bot size={20} strokeWidth={1.6} />}
              title="Agente IA"
              description="Persona, tom, follow-ups e regras de transferência do robô."
            />
          )}
          <ShortcutCard
            href="/conexoes"
            icon={<Wifi size={20} strokeWidth={1.6} />}
            title="Conexões"
            description="WhatsApp — status, QR, reconectar."
          />
          <ShortcutCard
            href="/configuracoes/email"
            icon={<Mail size={20} strokeWidth={1.6} />}
            title="E-mail"
            description="Conecte sua conta do Google para enviar e receber e-mails pelo CRM."
          />
          <ShortcutCard
            href="/configuracoes/kanban"
            icon={<Columns3 size={20} strokeWidth={1.6} />}
            title="Colunas do funil"
            description="Nome, cor, ordem e quais colunas aparecem no quadro."
          />
          {features.quickReplies && (
            <ShortcutCard
              href="/textos-rapidos"
              icon={<Zap size={20} strokeWidth={1.6} />}
              title="Textos rápidos"
              description='Atalhos que o atendente acessa digitando "/" no chat — frases prontas pra reusar.'
            />
          )}
          <ShortcutCard
            href="/superadmin/users"
            icon={<Users size={20} strokeWidth={1.6} />}
            title="Usuários"
            description="Gerentes e atendentes — criar, editar cargo e remover acessos."
          />
        </div>
      </div>
    </div>
  );
}
