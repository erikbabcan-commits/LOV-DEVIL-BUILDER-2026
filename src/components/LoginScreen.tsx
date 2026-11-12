import { useState } from 'react';
import { authApi } from '../services/auth';

/* LoginScreen — zobrazený IBA keď server ohlási auth:'enabled' a užívateľ
   nie je prihlásený (401 na /api/auth/me). Responzívne, a11y, SK texty. */

interface Props {
  onAuthenticated: () => void;
}

export function LoginScreen({ onAuthenticated }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = mode === 'login'
      ? await authApi.login(email, password)
      : await authApi.register(email, password);
    setBusy(false);
    if (res.ok) {
      onAuthenticated();
    } else {
      const messages: Record<string, string> = {
        invalid_credentials: 'Nesprávny e-mail alebo heslo.',
        email_taken: 'Tento e-mail už je zaregistrovaný.',
        invalid_email: 'Neplatný e-mail.',
        weak_password: 'Heslo musí mať aspoň 8 znakov.',
        invalid_credentials_format: 'Skontroluj e-mail a heslo (min 8 znakov).',
        network_error: 'Server teraz neodpovedá. Skontroluj pripojenie a skús to znova.'
      };
      setError(messages[res.error ?? ''] ?? 'Prihlásenie sa nepodarilo. Skús znova.');
    }
  };

  return (
    <div className="auth-gate" role="main" aria-label="Prihlásenie">
      <form className="auth-card" onSubmit={submit} aria-labelledby="authTitle">
        <b className="auth-brand">VORKEI<i>.</i></b>
        <h1 id="authTitle">{mode === 'login' ? 'Prihlásenie' : 'Registrácia'}</h1>
        <p className="auth-sub">
          {mode === 'login'
            ? 'Zadaj účtovné údaje a pokračuj do editora.'
            : 'Založ si účet — Free plán obsahuje 10 generácií mesačne.'}
        </p>

        <label htmlFor="authEmail">E-mail</label>
        <input
          id="authEmail"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={e => setEmail(e.target.value)}
          aria-invalid={error ? 'true' : undefined}
        />

        <label htmlFor="authPassword">Heslo (min. 8 znakov)</label>
        <input
          id="authPassword"
          type="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          minLength={8}
          required
          value={password}
          onChange={e => setPassword(e.target.value)}
        />

        {error && (
          <p className="auth-error" role="alert" aria-live="polite">{error}</p>
        )}

        <button type="submit" disabled={busy} aria-busy={busy}>
          {busy ? 'Prebieha…' : mode === 'login' ? 'Prihlásiť sa' : 'Vytvoriť účet'}
        </button>

        <button
          type="button"
          className="auth-switch"
          onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}
        >
          {mode === 'login' ? 'Nemáš účet? Zaregistruj sa' : 'Máš už účet? Prihlás sa'}
        </button>
      </form>
    </div>
  );
}
