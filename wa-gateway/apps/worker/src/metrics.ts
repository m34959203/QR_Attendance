import * as http from 'http';
import type { SessionManager } from './baileys/session-manager';
import type { EnvConfig } from '@wa-gateway/config';
import type { Logger } from 'pino';

const METRICS_PORT = parseInt(process.env.METRICS_PORT || '9090');

export function startMetricsServer(
  sessionManager: SessionManager,
  config: EnvConfig,
  logger: Logger,
): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      const statuses = sessionManager.getSessionStatuses();
      const totalInstances = statuses.length;
      const connectedInstances = statuses.filter((s) => s.connected).length;
      const disconnectedInstances = totalInstances - connectedInstances;

      const lines = [
        '# HELP wa_gateway_instances_total Total number of managed instances',
        '# TYPE wa_gateway_instances_total gauge',
        `wa_gateway_instances_total ${totalInstances}`,
        '',
        '# HELP wa_gateway_instances_connected Connected instances',
        '# TYPE wa_gateway_instances_connected gauge',
        `wa_gateway_instances_connected ${connectedInstances}`,
        '',
        '# HELP wa_gateway_instances_disconnected Disconnected instances',
        '# TYPE wa_gateway_instances_disconnected gauge',
        `wa_gateway_instances_disconnected ${disconnectedInstances}`,
        '',
        '# HELP wa_gateway_worker_up Worker service is up',
        '# TYPE wa_gateway_worker_up gauge',
        'wa_gateway_worker_up 1',
        '',
        `# HELP wa_gateway_memory_usage_bytes Process memory usage`,
        `# TYPE wa_gateway_memory_usage_bytes gauge`,
        `wa_gateway_memory_usage_bytes{type="rss"} ${process.memoryUsage().rss}`,
        `wa_gateway_memory_usage_bytes{type="heapUsed"} ${process.memoryUsage().heapUsed}`,
        `wa_gateway_memory_usage_bytes{type="heapTotal"} ${process.memoryUsage().heapTotal}`,
        '',
      ];

      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(lines.join('\n'));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.listen(METRICS_PORT, () => {
    logger.info({ port: METRICS_PORT }, 'Metrics server started');
  });

  return server;
}
