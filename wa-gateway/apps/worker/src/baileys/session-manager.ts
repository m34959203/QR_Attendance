import { PrismaClient } from '@wa-gateway/db';
import { InstanceStatus } from '@wa-gateway/types';
import { WASession } from './wa-session';
import type { Logger } from 'pino';

export class SessionManager {
  private sessions = new Map<string, WASession>();

  constructor(
    private db: PrismaClient,
    private logger: Logger,
  ) {}

  async restoreAll(): Promise<void> {
    const instances = await this.db.instance.findMany({
      where: { status: { in: ['CONNECTED', 'DISCONNECTED'] } },
    });

    this.logger.info(`Restoring ${instances.length} sessions...`);

    for (const instance of instances) {
      try {
        await this.startSession(instance.id);
      } catch (err) {
        this.logger.error({ instanceId: instance.id, err }, 'Failed to restore session');
      }
    }
  }

  async startSession(instanceId: string): Promise<WASession> {
    if (this.sessions.has(instanceId)) {
      return this.sessions.get(instanceId)!;
    }

    const session = new WASession(instanceId, this.db, this.logger);
    this.sessions.set(instanceId, session);

    await session.connect();
    return session;
  }

  async stopSession(instanceId: string): Promise<void> {
    const session = this.sessions.get(instanceId);
    if (session) {
      await session.disconnect();
      this.sessions.delete(instanceId);
    }
  }

  getSession(instanceId: string): WASession | undefined {
    return this.sessions.get(instanceId);
  }

  async disconnectAll(): Promise<void> {
    for (const [id, session] of this.sessions) {
      try {
        await session.disconnect();
      } catch (err) {
        this.logger.error({ instanceId: id, err }, 'Error disconnecting session');
      }
    }
    this.sessions.clear();
  }
}
