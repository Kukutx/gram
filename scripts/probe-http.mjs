/** An external scheduler can run this without granting database access. */
const base = process.env.PUBLIC_URL;
const token = process.env.METRICS_TOKEN;
if (!base || !token) throw new Error('PUBLIC_URL and METRICS_TOKEN are required');
try {
  const response = await fetch(new URL('/ops/health', base), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8_000),
  });
  const healthy = response.ok && (await response.json()).healthy === true;
  if (!healthy) process.exitCode = 2;
  console.log(healthy ? 'Operational probe healthy' : 'Operational probe unhealthy');
} catch {
  console.error('Operational probe unreachable');
  process.exitCode = 1;
}
