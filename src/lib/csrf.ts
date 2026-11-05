/* CSRF helper — číta readable cookie lov_csrf, ktorú server nastavuje pri logine.
   Server (auth mód) vyžaduje X-CSRF-Token pri všetkých mutujúcich požiadavkách. */

export function getCsrfToken(): string {
  if (typeof document === 'undefined') return '';
  for (const part of document.cookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === 'lov_csrf') return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}

/** Spoločné hlavičky pre mutujúce API volania ( Content-Type + CSRF). */
export function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const csrf = getCsrfToken();
  return {
    'Content-Type': 'application/json',
    ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    ...extra
  };
}
