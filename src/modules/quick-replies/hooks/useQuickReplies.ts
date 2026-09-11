'use client';

import { invalidar, useDados } from '@/lib/useDados';

const QUICK_REPLIES_URL = '/api/admin/quick-replies';

export interface QuickReplyView {
  id: string;
  shortcut: string;
  body: string;
  label: string | null;
  variations: string[] | null;
}

interface QuickRepliesResponse {
  items: QuickReplyView[];
}

const EMPTY_QUICK_REPLIES: QuickReplyView[] = [];

export function useQuickReplies(): QuickReplyView[] {
  const { dado } = useDados<QuickRepliesResponse>(QUICK_REPLIES_URL);
  return dado?.items ?? EMPTY_QUICK_REPLIES;
}

export function invalidarQuickReplies() {
  invalidar(QUICK_REPLIES_URL);
}
