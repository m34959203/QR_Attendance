import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
  getContentType,
} from '@whiskeysockets/baileys';
import { PrismaClient } from '@wa-gateway/db';
import { Redis } from 'ioredis';
import * as QRCode from 'qrcode';
import * as path from 'path';
import * as fs from 'fs';
import type { Logger } from 'pino';

const SESSIONS_DIR = process.env.SESSIONS_DIR || path.resolve(__dirname, '../../../../sessions');
const QR_TTL_SECONDS = 60;

export class WASession {
  private socket: ReturnType<typeof makeWASocket> | null = null;
  private qrCode: string | null = null;
  private _connected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    public readonly instanceId: string,
    private db: PrismaClient,
    private redis: Redis,
    private logger: Logger,
  ) {}

  isConnected(): boolean { return this._connected; }

  async connect(): Promise<void> {
    const sessionDir = path.join(SESSIONS_DIR, this.instanceId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    this.socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger.child({ module: 'signal' })),
      },
      printQRInTerminal: false,
      logger: this.logger.child({ instanceId: this.instanceId, module: 'baileys' }),
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
    });

    // === Connection lifecycle ===
    this.socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qrCode = await QRCode.toDataURL(qr);
        await this.redis.set(`qr:${this.instanceId}`, this.qrCode, 'EX', QR_TTL_SECONDS);
        await this.updateStatus('QR_READY');
        await this.publishStateWebhook('qr');
        this.logger.info({ instanceId: this.instanceId }, 'QR code generated');
      }

      if (connection === 'open') {
        this.reconnectAttempts = 0;
        this._connected = true;
        this.qrCode = null;
        await this.redis.del(`qr:${this.instanceId}`);
        const phoneNumber = this.socket?.user?.id?.split(':')[0] || null;
        await this.db.instance.update({
          where: { id: this.instanceId },
          data: { status: 'CONNECTED', phoneNumber },
        });
        await this.publishStateWebhook('connected');
        this.logger.info({ instanceId: this.instanceId, phoneNumber }, 'Connected');
      }

      if (connection === 'close') {
        this._connected = false;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        await this.updateStatus('DISCONNECTED');
        await this.publishStateWebhook('disconnected');

        if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
          this.logger.info({ instanceId: this.instanceId, attempt: this.reconnectAttempts, delay }, 'Reconnecting...');
          this.reconnectTimer = setTimeout(() => this.connect(), delay);
        } else {
          this.logger.warn({ instanceId: this.instanceId, statusCode }, 'Not reconnecting');
          if (statusCode === DisconnectReason.loggedOut) {
            fs.rmSync(path.join(SESSIONS_DIR, this.instanceId), { recursive: true, force: true });
          }
        }
      }
    });

    this.socket.ev.on('creds.update', saveCreds);

    // === Incoming messages ===
    this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const chatId = msg.key.remoteJid;
        if (!chatId) continue;

        try {
          const { msgType, content } = this.extractMessageContent(msg);
          await this.db.message.create({
            data: {
              instanceId: this.instanceId,
              messageId: msg.key.id || `in_${Date.now()}`,
              direction: 'INCOMING', chatId,
              type: msgType as any, content, status: 'DELIVERED',
            },
          });

          const webhookPayload = {
            typeWebhook: 'incomingMessageReceived',
            instanceData: { idInstance: this.instanceId, phone: this.socket?.user?.id?.split(':')[0] || '' },
            timestamp: Math.floor(Date.now() / 1000),
            body: {
              idMessage: msg.key.id,
              messageData: { typeMessage: msgType, ...content },
              senderData: { chatId, sender: msg.key.participant || chatId, senderName: msg.pushName || '' },
            },
          };

          await this.db.notification.create({
            data: {
              instanceId: this.instanceId, type: 'incomingMessageReceived',
              body: webhookPayload, expiresAt: new Date(Date.now() + 86400000),
            },
          });
          await this.dispatchWebhook(webhookPayload);
          this.logger.info({ instanceId: this.instanceId, chatId, type: msgType }, 'Incoming message');
        } catch (err) {
          this.logger.error({ instanceId: this.instanceId, err }, 'Failed to process incoming');
        }
      }
    });

    // === Delivery status updates ===
    this.socket.ev.on('messages.update', async (updates) => {
      for (const upd of updates) {
        if (!upd.key.id || !upd.update.status) continue;
        const map: Record<number, string> = { 2: 'SENT', 3: 'DELIVERED', 4: 'READ', 5: 'READ' };
        const newStatus = map[upd.update.status];
        if (!newStatus) continue;

        try {
          await this.db.message.updateMany({
            where: { instanceId: this.instanceId, messageId: upd.key.id },
            data: { status: newStatus as any },
          });

          const webhookPayload = {
            typeWebhook: 'outgoingMessageStatus',
            instanceData: { idInstance: this.instanceId, phone: this.socket?.user?.id?.split(':')[0] || '' },
            timestamp: Math.floor(Date.now() / 1000),
            body: { idMessage: upd.key.id, status: newStatus.toLowerCase(), chatId: upd.key.remoteJid || '' },
          };

          await this.db.notification.create({
            data: {
              instanceId: this.instanceId, type: 'outgoingMessageStatus',
              body: webhookPayload, expiresAt: new Date(Date.now() + 86400000),
            },
          });
          await this.dispatchWebhook(webhookPayload);
        } catch (err) {
          this.logger.error({ err, messageId: upd.key.id }, 'Failed to update status');
        }
      }
    });

    await this.updateStatus('STARTING');
  }

  // === Send methods ===
  async sendText(chatId: string, text: string, quotedMessageId?: string): Promise<string> {
    this.ensureSocket();
    const opts = quotedMessageId ? { quoted: { key: { id: quotedMessageId, remoteJid: chatId } } as any } : undefined;
    const msg = await this.socket!.sendMessage(chatId, { text }, opts);
    return msg?.key.id || `sent_${Date.now()}`;
  }

  async sendImage(chatId: string, image: string, caption?: string): Promise<string> {
    this.ensureSocket();
    const c: any = { caption };
    c.image = image.startsWith('http') ? { url: image } : Buffer.from(image, 'base64');
    return (await this.socket!.sendMessage(chatId, c))?.key.id || `sent_${Date.now()}`;
  }

  async sendDocument(chatId: string, document: string, fileName: string, caption?: string): Promise<string> {
    this.ensureSocket();
    const c: any = { fileName, caption, mimetype: 'application/octet-stream' };
    c.document = document.startsWith('http') ? { url: document } : Buffer.from(document, 'base64');
    return (await this.socket!.sendMessage(chatId, c))?.key.id || `sent_${Date.now()}`;
  }

  async sendAudio(chatId: string, audio: string): Promise<string> {
    this.ensureSocket();
    const c: any = { mimetype: 'audio/mp4', ptt: true };
    c.audio = audio.startsWith('http') ? { url: audio } : Buffer.from(audio, 'base64');
    return (await this.socket!.sendMessage(chatId, c))?.key.id || `sent_${Date.now()}`;
  }

  async sendLocation(chatId: string, lat: number, lng: number, name?: string): Promise<string> {
    this.ensureSocket();
    return (await this.socket!.sendMessage(chatId, {
      location: { degreesLatitude: lat, degreesLongitude: lng, name: name || '' },
    }))?.key.id || `sent_${Date.now()}`;
  }

  async sendContact(chatId: string, contact: { name: string; phone: string }): Promise<string> {
    this.ensureSocket();
    const digits = contact.phone.replace(/\D/g, '');
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${contact.name}\nTEL;type=CELL;waid=${digits}:${contact.phone}\nEND:VCARD`;
    return (await this.socket!.sendMessage(chatId, {
      contacts: { displayName: contact.name, contacts: [{ vcard }] },
    }))?.key.id || `sent_${Date.now()}`;
  }

  async sendPoll(chatId: string, name: string, options: string[], multi?: boolean): Promise<string> {
    this.ensureSocket();
    return (await this.socket!.sendMessage(chatId, {
      poll: { name, values: options, selectableCount: multi ? 0 : 1 },
    }))?.key.id || `sent_${Date.now()}`;
  }

  async sendReaction(chatId: string, messageId: string, reaction: string): Promise<string> {
    this.ensureSocket();
    return (await this.socket!.sendMessage(chatId, {
      react: { text: reaction, key: { id: messageId, remoteJid: chatId } },
    }))?.key.id || `sent_${Date.now()}`;
  }

  async sendTyping(chatId: string, durationMs: number): Promise<void> {
    this.ensureSocket();
    await this.socket!.sendPresenceUpdate('composing', chatId);
    setTimeout(async () => {
      try { await this.socket?.sendPresenceUpdate('paused', chatId); } catch { /* */ }
    }, Math.min(durationMs, 30000));
  }

  // === Chat & contact methods ===
  async getChats(): Promise<any[]> {
    const msgs = await this.db.message.findMany({
      where: { instanceId: this.instanceId },
      orderBy: { timestamp: 'desc' }, distinct: ['chatId'], take: 50,
      select: { chatId: true, timestamp: true, content: true, direction: true },
    });
    return msgs.map((m) => ({ chatId: m.chatId, lastMessageTime: m.timestamp, lastMessage: m.content, direction: m.direction }));
  }

  async getChatHistory(chatId: string, limit: number, offset: number): Promise<any[]> {
    return this.db.message.findMany({
      where: { instanceId: this.instanceId, chatId },
      orderBy: { timestamp: 'desc' }, take: limit, skip: offset,
    });
  }

  async checkNumber(phone: string): Promise<{ exists: boolean; jid?: string }> {
    this.ensureSocket();
    const [r] = await this.socket!.onWhatsApp(phone.replace(/\D/g, ''));
    return r ? { exists: r.exists, jid: r.jid } : { exists: false };
  }

  async getContactInfo(chatId: string): Promise<any> {
    this.ensureSocket();
    const status = await this.socket!.fetchStatus(chatId).catch(() => null);
    const pic = await this.socket!.profilePictureUrl(chatId, 'image').catch(() => null);
    return { chatId, status: status?.status, profilePictureUrl: pic };
  }

  async getGroups(): Promise<any[]> {
    this.ensureSocket();
    const groups = await this.socket!.groupFetchAllParticipating();
    return Object.values(groups).map((g: any) => ({
      groupId: g.id, subject: g.subject, creation: g.creation, participants: g.participants?.length || 0,
    }));
  }

  async createGroup(name: string, participants: string[]): Promise<any> {
    this.ensureSocket();
    const r = await this.socket!.groupCreate(name, participants);
    return { groupId: r.id, subject: name };
  }

  getQR(): string | null { return this.qrCode; }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.socket) { this.socket.end(undefined); this.socket = null; }
    this._connected = false;
    await this.redis.del(`qr:${this.instanceId}`);
  }

  async logout(): Promise<void> {
    if (this.socket) { await this.socket.logout(); this.socket.end(undefined); this.socket = null; }
    this._connected = false;
    fs.rmSync(path.join(SESSIONS_DIR, this.instanceId), { recursive: true, force: true });
    await this.redis.del(`qr:${this.instanceId}`);
    await this.updateStatus('DISCONNECTED');
  }

  // === Private ===
  private ensureSocket(): void {
    if (!this.socket || !this._connected) throw new Error('Socket not connected');
  }

  private extractMessageContent(msg: proto.IWebMessageInfo): { msgType: string; content: Record<string, unknown> } {
    const m = msg.message!;
    const ct = getContentType(m);
    switch (ct) {
      case 'conversation': return { msgType: 'TEXT', content: { textMessage: m.conversation } };
      case 'extendedTextMessage': return { msgType: 'TEXT', content: { textMessage: m.extendedTextMessage?.text } };
      case 'imageMessage': return { msgType: 'IMAGE', content: { caption: m.imageMessage?.caption, mimetype: m.imageMessage?.mimetype } };
      case 'documentMessage': return { msgType: 'DOCUMENT', content: { fileName: m.documentMessage?.fileName, caption: m.documentMessage?.caption } };
      case 'audioMessage': return { msgType: 'AUDIO', content: { seconds: m.audioMessage?.seconds, ptt: m.audioMessage?.ptt } };
      case 'locationMessage': return { msgType: 'LOCATION', content: { latitude: m.locationMessage?.degreesLatitude, longitude: m.locationMessage?.degreesLongitude, name: m.locationMessage?.name } };
      case 'contactMessage': return { msgType: 'CONTACT', content: { vcard: m.contactMessage?.vcard, displayName: m.contactMessage?.displayName } };
      default: return { msgType: 'TEXT', content: { raw: ct } };
    }
  }

  private async updateStatus(status: string): Promise<void> {
    try {
      await this.db.instance.update({ where: { id: this.instanceId }, data: { status: status as any } });
    } catch (err) {
      this.logger.error({ instanceId: this.instanceId, err }, 'Failed to update status');
    }
  }

  private async publishStateWebhook(status: string): Promise<void> {
    const payload = {
      typeWebhook: 'stateInstanceChanged',
      instanceData: { idInstance: this.instanceId, phone: this.socket?.user?.id?.split(':')[0] || '' },
      timestamp: Math.floor(Date.now() / 1000),
      body: { statusInstance: status },
    };
    await this.db.notification.create({
      data: { instanceId: this.instanceId, type: 'stateInstanceChanged', body: payload, expiresAt: new Date(Date.now() + 86400000) },
    });
    await this.dispatchWebhook(payload);
  }

  private async dispatchWebhook(payload: Record<string, unknown>): Promise<void> {
    const inst = await this.db.instance.findUnique({ where: { id: this.instanceId }, select: { webhookUrl: true } });
    if (!inst?.webhookUrl) return;
    await this.redis.lpush('wa-webhook:pending', JSON.stringify({
      instanceId: this.instanceId, webhookUrl: inst.webhookUrl, payload,
    }));
  }
}
