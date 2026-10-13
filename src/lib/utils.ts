export const esc = (s: unknown): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function hl(code: string): string {
  let s = esc(code);
  s = s.replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tok-com">$1</span>');
  s = s.replace(/("[^"\n]*")/g, '<span class="tok-str">$1</span>');
  s = s.replace(/(&lt;\/?)([a-zA-Z][\w-]*)/g, '$1<span class="tok-tag">$2</span>');
  return s;
}

export const now = (): string =>
  new Date().toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });

export const uid = (): string => Math.random().toString(36).slice(2, 9);

export const dbg = (...a: unknown[]): void => {
  if (typeof console !== 'undefined' && console.debug) {
    console.debug('[Forge]', new Date().toISOString().slice(11, 23), ...a);
  }
};

export function copy(t: string): void {
  try {
    const nav = navigator as Navigator & { clipboard?: { writeText(s: string): Promise<void> } };
    const p = nav.clipboard && nav.clipboard.writeText(t);
    if (p && p.catch) {
      p.catch(() => {
        try {
          const ta = document.createElement('textarea');
          ta.value = t;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        } catch { /* ignore */ }
      });
    }
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch { /* ignore */ }
  }
}
