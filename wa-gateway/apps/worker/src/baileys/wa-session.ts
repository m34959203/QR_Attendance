import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { PrismaClient } from '@wa-gateway/db';
import * as QRCode from 'qrcode';
import * as path from 'path';
import * as fs from 'fs';
import type { Logger } from 'pino';

const SESSIONS_DIR = process.env.SESSIONS_DIR || path.resolve(__dirname, '../../../../sessions');

export class WASession {
  private socket: ReturnType<typeof makeWASocket> | null = null;
  private qrCode: string | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

  constructor(
    public readonly instanceId: string,
    private db: PrismaClient,
    private logger: Logger,
  ) {}

  async connect(): Promise<void> {
    const sessionDir = path.join(SESSIONS_DIR, this.instanceId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    this.socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger),
      },
      printQRInTerminal: false,
      logger: this.logger.child({ instanceId: this.instanceId }),
    });

    // Connection updates
    this.socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qrCode = await QRCode.toDataURL(qr);
        await this.updateStatus('QR_READY');
        this.logger.info({ instanceId: this.instanceId }, 'QR code generated');
      }

      if (connection === 'open') {
        this.reconnectAttempts = 0;
        this.qrCode = null;

        // Get phone number from socket
        const phoneNumber = this.socket?.user?.id?.split(':')[0] || null;
        await this.db.instance.update({
          where: { id: this.instanceId },
          data: { status: 'CONNECTED', phoneNumber },
        });

        this.logger.info({ instanceId: this.instanceId, phoneNumber }, 'Connected');
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        await this.updateStatus('DISCONNECTED');

        if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
          this.logger.info({
            instanceId: this.instanceId,
            attempt: this.reconnectAttempts,
            delay,
          }, 'Reconnecting...');

          setTimeout(() => this.connect(), delay);
        } else {
          this.logger.warn({ instanceId: this.instanceId }, 'Not reconnecting');
        }
      }
    });

    // Save credentials
    this.socket.ev.on('creds.update', saveCreds);

    // Incoming messages
    this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;

        const chatId = msg.key.remoteJid;
        if (!chatId) continue;

        // Store incoming message
        await this.db.message.create({
          data: {
            instanceId: this.instanceId,
            messageId: msg.key.id || `incoming_${Date.now()}`,
            direction: 'INCOMING',
            chatId,
            type: 'TEXT', // TODO: detect actual type
            content: {
              text: msg.message?.conversation || msg.message?.extendedTextMessage?.text || '',
            },
            status: 'DELIVERED',
          },
        });

        // Create notification for polling
        await this.db.notification.create({
          data: {
            instanceId: this.instanceId,
            type: 'incomingMessageReceived',
            body: {
              typeWebhook: 'incomingMessageReceived',
              instanceData: {
                idInstance: this.instanceId,
                phone: this.socket?.user?.id?.split(':')[0] || '',
              },
              timestamp: Math.floor(Date.now() / 1000),
              body: {
                messageData: {
                  typeMessage: 'textMessage',
                  textMessageData: {
                    textMessage: msg.message?.conversation || msg.message?.extendedTextMessage?.text || '',
                  },
                },
                senderData: {
                  chatId,
                  sender: chatId,
                },
              },
            },
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h TTL
          },
        });

        this.logger.info({ instanceId: this.instanceId, chatId }, 'Incoming message stored');
      }
    });

    await this.updateStatus('STARTING');
  }

  async sendText(chatId: string, text: string, quotedMessageId?: string): Promise<string> {
    if (!this.socket) throw new Error('Socket not initialized');

    const msg = await this.socket.sendMessage(chatId, {
      text,
    }, quotedMessageId ? { quoted: { key: { id: quotedMessageId, remoteJid: chatId } } as any } : undefined);

    return msg?.key.id || `sent_${Date.now()}`;
  }

  async sendImage(chatId: string, image: Buffer | string, caption?: string): Promise<string> {
    if (!this.socket) throw new Error('Socket not initialized');

    const content: any = { caption };
    if (typeof image === 'string' && image.startsWith('http')) {
      content.image = { url: image };
    } else {
      content.image = typeof image === 'string' ? Buffer.from(image, 'base64') : image;
    }

    const msg = await this.socket.sendMessage(chatId, content);
    return msg?.key.id || `sent_${Date.now()}`;
  }

  async sendDocument(chatId: string, document: Buffer | string, fileName: string, caption?: string): Promise<string> {
    if (!this.socket) throw new Error('Socket not initialized');

    const content: any = { fileName, caption, mimetype: 'application/octet-stream' };
    if (typeof document === 'string' && document.startsWith('http')) {
      content.document = { url: document };
    } else {
      content.document = typeof document === 'string' ? Buffer.from(document, 'base64') : document;
    }

    const msg = await this.socket.sendMessage(chatId, content);
    return msg?.key.id || `sent_${Date.now()}`;
  }

  getQR(): string | null {
    return this.qrCode;
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.end(undefined);
      this.socket = null;
    }
  }

  private async updateStatus(status: string): Promise<void> {
    try {
      await this.db.instance.update({
        where: { id: this.instanceId },
        data: { status: status as any },
      });
    } catch (err) {
      this.logger.error({ instanceId: this.instanceId, err }, 'Failed to update status');
    }
  }
}
