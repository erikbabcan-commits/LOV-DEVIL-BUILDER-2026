/**
 * VORKEI 1-Click Instant Shareable Link Service
 * Vytvára a manažuje verejné odkazy pre klientov bez nutnosti prihlasovania.
 */

import { apiUrl } from '../../lib/api';

export interface InstantShareResponse {
  ok: boolean;
  shareId: string;
  shareUrl: string;
  title: string;
  error?: string;
}

export async function createInstantShare(
  projectId: string,
  title: string,
  html: string
): Promise<InstantShareResponse> {
  const url = apiUrl('/api/share/create');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      projectId,
      title,
      html
    })
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  return (await res.json()) as InstantShareResponse;
}

export async function getInstantShare(shareId: string) {
  const url = apiUrl(`/api/share/${encodeURIComponent(shareId)}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.json();
}
