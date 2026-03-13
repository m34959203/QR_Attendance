import { PrismaClient } from '@wa-gateway/db';
import { WASession } from './wa-session';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';

export class SessionManager {
  private sessions = new Map<string, WASession>();
  private redis: Redis;
  private sub: Redis;

  constructor(
    private db: PrismaClient,
    private logger: Logger,
    redisUrl: string,
  ) {
    this.redis = new Redis(redisUrl);

    this.sub = new Redis(redisUrl);
    this.sub.subscribe('instance:commands');
    this.sub.on('message', (_channel, message) => {
      try {
        const cmd = JSON.parse(message);
        this.handleCommand(cmd).catch((err) =>
          this.logger.error({ err, cmd }, 'Failed to handle command'),
        );
      } catch { /* ignore */ }
    });
  }

  private async handleCommand(cmd: { action: string; instanceId: string } & Record<string, unknown>): Promise<void> {
    this.logger.info({ cmd }, 'Received instance command');
    switch (cmd.action) {
      case 'start':
        await this.startSession(cmd.instanceId);
        break;
      case 'stop':
        await this.stopSession(cmd.instanceId);
        break;
      case 'logout':
        await this.logoutSession(cmd.instanceId);
        break;
      case 'send_typing': {
        const session = this.sessions.get(cmd.instanceId);
        if (session) {
          await session.sendTyping(cmd.chatId as string, cmd.durationMs as number);
        }
        break;
      }
    }
  }

  async restoreAll(): Promise<void> {
    const instances = await this.db.instance.findMany({
      where: { status: { in: ['CONNECTED', 'DISCONNECTED'] } },
    });
    this.logger.info(`Restoring ${instances.length} sessions...`);
    const results = await Promise.allSettled(instances.map((i) => this.startSession(i.id)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fail = results.filter((r) => r.status === 'rejected').length;
    this.logger.info({ ok, fail }, 'Session restoration complete');
  }

  async startSession(instanceId: string): Promise<WASession> {
    if (this.sessions.has(instanceId)) return this.sessions.get(instanceId)!;
    const session = new WASession(instanceId, this.db, this.redis, this.logger);
    this.sessions.set(instanceId, session);
    try {
      await session.connect();
    } catch (err) {
      this.sessions.delete(instanceId);
      throw err;
    }
    return session;
  }

  async stopSession(instanceId: string): Promise<void> {
    const s = this.sessions.get(instanceId);
    if (s) { await s.disconnect(); this.sessions.delete(instanceId); }
  }

  async logoutSession(instanceId: string): Promise<void> {
    const s = this.sessions.get(instanceId);
    if (s) { await s.logout(); this.sessions.delete(instanceId); }
  }

  getSession(instanceId: string): WASession | undefined {
    return this.sessions.get(instanceId);
  }

  getSessionCount(): number { return this.sessions.size; }

  getSessionStatuses(): Array<{ instanceId: string; connected: boolean }> {
    return Array.from(this.sessions.entries()).map(([id, s]) => ({
      instanceId: id, connected: s.isConnected(),
    }));
  }

  async disconnectAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.sessions.entries()).map(async ([id, session]) => {
        try { await session.disconnect(); } catch (err) {
          this.logger.error({ instanceId: id, err }, 'Error disconnecting');
        }
      }),
    );
    this.sessions.clear();
    this.sub.disconnect();
    this.redis.disconnect();
  }
}
