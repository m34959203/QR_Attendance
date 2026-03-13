import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getDb } from '@wa-gateway/db';
import { ErrorCode } from '@wa-gateway/types';

export async function notificationRoutes(app: FastifyInstance) {

  // GET /:id/notifications — Get one notification (polling)
  app.get<{ Params: { id: string } }>('/:id/notifications', async (request, reply) => {
    if (request.params.id !== request.instanceId) {
      return reply.status(403).send({ error: ErrorCode.FORBIDDEN, message: 'Access denied', code: 403 });
    }

    const db = getDb();

    // Clean up expired notifications
    await db.notification.deleteMany({
      where: {
        instanceId: request.params.id,
        expiresAt: { lt: new Date() },
      },
    });

    // Get oldest unread notification
    const notification = await db.notification.findFirst({
      where: { instanceId: request.params.id },
      orderBy: { createdAt: 'asc' },
    });

    if (!notification) {
      return reply.status(200).send(null);
    }

    return {
      receiptId: Number(notification.receiptId),
      body: notification.body,
    };
  });

  // DELETE /:id/notifications/:receiptId — Acknowledge notification
  app.delete<{ Params: { id: string; receiptId: string } }>('/:id/notifications/:receiptId', async (request, reply) => {
    if (request.params.id !== request.instanceId) {
      return reply.status(403).send({ error: ErrorCode.FORBIDDEN, message: 'Access denied', code: 403 });
    }

    const db = getDb();

    try {
      await db.notification.delete({
        where: { receiptId: BigInt(request.params.receiptId) },
      });
      return { success: true };
    } catch {
      return reply.status(404).send({
        error: 'NOTIFICATION_NOT_FOUND',
        message: 'Notification not found or already acknowledged',
        code: 404,
      });
    }
  });
}
