'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import LeadModal from '@/components/crm/LeadModal';

/**
 * Página de lead direta — renderiza o LeadModal por cima de um background
 * vazio (acessível por URL direta /crm/[leadId]). Fechar volta pra /crm.
 */
export default function LeadPage({ params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = use(params);
  const router = useRouter();

  return (
    <div className="h-[calc(100vh-64px)]">
      <LeadModal
        leadId={leadId}
        onClose={() => router.push('/crm')}
      />
    </div>
  );
}
