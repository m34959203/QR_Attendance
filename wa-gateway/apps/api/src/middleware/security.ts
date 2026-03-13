import { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

async function securityHeadersImpl(app: FastifyInstance) {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-XSS-Protection', '1; mode=block');
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    reply.header('X-Permitted-Cross-Domain-Policies', 'none');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  });
}

export const securityHeaders = fp(securityHeadersImpl, { name: 'security-headers' });
