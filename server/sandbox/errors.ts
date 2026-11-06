export type SandboxErrorCode = 'sandbox_busy' | 'sandbox_queue_timeout' | 'sandbox_timeout' |
  'sandbox_aborted' | 'sandbox_unavailable' | 'sandbox_protocol' | 'sandbox_worker_failed' |
  'sandbox_output_limit' | 'sandbox_cleanup_failed';

const messages: Record<SandboxErrorCode, string> = {
  sandbox_busy: 'Fronta kompilácie je plná. Skús to neskôr.',
  sandbox_queue_timeout: 'Vypršal čas čakania na kompiláciu.',
  sandbox_timeout: 'Kompilácia prekročila časový limit.',
  sandbox_aborted: 'Kompilácia bola zrušená.',
  sandbox_unavailable: 'Izolovaný kompilátor nie je dostupný.',
  sandbox_protocol: 'Kompilátor vrátil neplatnú odpoveď.',
  sandbox_worker_failed: 'Izolovaný worker zlyhal alebo prekročil limit zdrojov.',
  sandbox_output_limit: 'Výstup kompilátora prekročil limit.',
  sandbox_cleanup_failed: 'Upratanie workera zlyhalo; runner bol zablokovaný.',
};

export class SandboxError extends Error {
  constructor(public readonly code: SandboxErrorCode) { super(messages[code]); this.name = 'SandboxError'; }
  get status(): 408 | 429 | 502 | 503 | 504 {
    if (this.code === 'sandbox_busy' || this.code === 'sandbox_queue_timeout') return 429;
    if (this.code === 'sandbox_timeout') return 504;
    if (this.code === 'sandbox_aborted') return 408;
    if (this.code === 'sandbox_protocol' || this.code === 'sandbox_output_limit') return 502;
    return 503;
  }
}

export function asSandboxError(error: unknown): SandboxError {
  return error instanceof SandboxError ? error : new SandboxError('sandbox_unavailable');
}
