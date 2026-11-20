import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const suite = process.platform === 'win32' ? describe.skip : describe;
const read = (name: string) => readFileSync(new URL(`../deploy/${name}`, import.meta.url), 'utf8');

suite('one-command install scripts', () => {
  it.each(['gcp-free.sh', 'server-install.sh', 'up.sh', 'backup.sh'])('%s is valid bash', (name) => {
    const result = spawnSync('bash', ['-n', new URL(`../deploy/${name}`, import.meta.url).pathname]);
    expect(result.stderr.toString()).toBe('');
    expect(result.status).toBe(0);
  });

  it('sends the bot token over stdin, never on a command line', () => {
    const script = read('gcp-free.sh');
    const sshCommands = script.split('\n').filter((line) => line.includes('ssh_vm '));
    expect(sshCommands.length).toBeGreaterThan(0);
    for (const line of sshCommands) expect(line).not.toContain('TOKEN');
    expect(script).toContain('tee /etc/gram/env.install');
  });

  it('stays inside the GCP free tier', () => {
    const script = read('gcp-free.sh');
    expect(script).toContain('--machine-type=e2-micro');
    expect(script).toContain('--boot-disk-type=pd-standard');
    expect(script).toMatch(/--boot-disk-size=30GB/);
    const zones = script.match(/ZONES=\(\$\{GRAM_ZONE:-([^}]*)\}\)/)?.[1]?.split(' ') ?? [];
    expect(zones.length).toBeGreaterThan(0);
    for (const zone of zones) expect(zone).toMatch(/^us-(central1|west1|east1)-[a-f]$/);
  });

  it('keeps generated secrets and settings across re-runs', () => {
    const script = read('server-install.sh');
    expect(script).toMatch(/\[\[ -s \.env \]\] \|\| cp \.env\.example \.env/);
    expect(script).toMatch(/get_env POSTGRES_PASSWORD\)" \]\] \|\| set_env POSTGRES_PASSWORD/);
    expect(script).toContain('rm -f "$INSTALL_ENV"');
  });
});
