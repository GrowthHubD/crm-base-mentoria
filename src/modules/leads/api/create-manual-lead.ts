import type { ManualLeadRequest } from '../manual-create';

export async function createManualLeadRequest(
  input: ManualLeadRequest
): Promise<{ lead: { id: string } }> {
  let unitId: string | null = null;
  try {
    const selected = localStorage.getItem('unidade-selecionada');
    unitId = selected && selected !== 'todas' ? selected : null;
  } catch {
    unitId = null;
  }

  const response = await fetch('/api/leads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(unitId ? { 'x-unit-id': unitId } : {}),
    },
    body: JSON.stringify(input),
  });
  const json = (await response.json().catch(() => ({}))) as {
    lead?: { id: string };
    error?: string;
  };
  if (!response.ok || !json.lead) {
    throw new Error(json.error ?? `HTTP ${response.status}`);
  }
  return { lead: json.lead };
}
