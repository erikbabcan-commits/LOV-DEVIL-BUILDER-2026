import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';

function requiredMatch(command: string, pattern: RegExp, name: string): string {
  const value = command.match(pattern)?.[1];
  if (!value) throw new Error(`${name} is missing from script: ${command}`);
  return value;
}

describe('E2E server configuration', () => {
  it('routes browser AI requests through the Vite server and Hono proxy', () => {
    const serverCommand = packageJson.scripts['server:e2e'];
    const viteCommand = packageJson.scripts['dev:e2e'];
    const honoPort = requiredMatch(serverCommand, /(?:^|\s)PORT=(\d+)(?:\s|$)/, 'Hono port');
    const proxyPort = requiredMatch(viteCommand, /VITE_API_PROXY_TARGET=http:\/\/127\.0\.0\.1:(\d+)/, 'proxy port');
    const vitePort = requiredMatch(viteCommand, /vite --port (\d+)(?:\s|$)/, 'Vite port');

    expect(honoPort).toBe('8788');
    expect(vitePort).toBe('5174');
    expect(proxyPort).toBe(honoPort);
    expect(viteCommand).not.toContain('VITE_AI_API_BASE=');
  });
});
