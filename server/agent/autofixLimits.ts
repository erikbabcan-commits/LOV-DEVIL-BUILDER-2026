/* Autofix attempt limits, in a dependency-free module so server/index.ts can read them
   without eagerly loading the sandbox (autofix.ts itself stays a lazy import). */

/** Najviac 3 platené AI pokusy na jedno volanie (Agent 9, schválené Erikom). */
export const MAX_ATTEMPTS = 3;
/** Klienti, ktorí nepošlú `maxAttempts` (napr. starý PWA klient z cache so schémou attempts ≤ 2),
 *  dostanú najviac 2 pokusy, aby nezaplatili za odpoveď, ktorú by odmietli (Bora W3 P3-4). */
export const LEGACY_CLIENT_MAX_ATTEMPTS = 2;
