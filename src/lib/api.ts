/**
 * Verejná konfigurácia API URL pre frontend.
 *
 * Ak je nastavená premenná VITE_API_BASE_URL, požiadavky smerujú na zadanú verejnú adresu.
 * Ak nastavená nie je, zachová sa relatívna cesta (/api/...), čo umožňuje lokálny vývoj
 * cez Vite proxy (alebo prevádzku za rovnakým reverzným proxy ako Caddy/Nginx).
 */

export function getApiBaseUrl(): string {
  const envUrl = (import.meta.env?.VITE_API_BASE_URL ?? '').trim();
  return envUrl.replace(/\/+$/, '');
}

export function apiUrl(path: string): string {
  const base = getApiBaseUrl();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${normalizedPath}` : normalizedPath;
}
