import { FastifyInstance } from 'fastify';
import { getDb } from '@wa-gateway/db';

export async function metricsRoute(app: FastifyInstance) {
  app.get('/metrics', async (request, reply) => {
    const db = getDb();

    const [totalInstances, connectedInstances, totalMessages, pendingMessages] = await Promise.all([
      db.instance.count(),
      db.instance.count({ where: { status: 'CONNECTED' } }),
      db.message.count(),
      db.message.count({ where: { status: 'PENDING' } }),
    ]);

    const lines = [
      '# HELP wa_api_instances_total Total instances',
      '# TYPE wa_api_instances_total gauge',
      `wa_api_instances_total ${totalInstances}`,
      '',
      '# HELP wa_api_instances_connected Connected instances',
      '# TYPE wa_api_instances_connected gauge',
      `wa_api_instances_connected ${connectedInstances}`,
      '',
      '# HELP wa_api_messages_total Total messages in DB',
      '# TYPE wa_api_messages_total gauge',
      `wa_api_messages_total ${totalMessages}`,
      '',
      '# HELP wa_api_messages_pending Pending outgoing messages',
      '# TYPE wa_api_messages_pending gauge',
      `wa_api_messages_pending ${pendingMessages}`,
      '',
      '# HELP wa_api_up API service is up',
      '# TYPE wa_api_up gauge',
      'wa_api_up 1',
      '',
      `# HELP wa_api_memory_bytes Memory usage`,
      `# TYPE wa_api_memory_bytes gauge`,
      `wa_api_memory_bytes{type="rss"} ${process.memoryUsage().rss}`,
      `wa_api_memory_bytes{type="heapUsed"} ${process.memoryUsage().heapUsed}`,
      '',
    ];

    reply.header('Content-Type', 'text/plain; version=0.0.4');
    return lines.join('\n');
  });
}
