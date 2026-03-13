// === Instance ===

export enum InstanceStatus {
  STARTING = 'STARTING',
  QR_READY = 'QR_READY',
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
}

export interface InstanceSettings {
  delaySend?: number;
  keepOnline?: boolean;
}

export interface CreateInstanceBody {
  webhookUrl?: string;
  settings?: InstanceSettings;
}

export interface UpdateSettingsBody {
  webhookUrl?: string;
  delaySend?: number;
  keepOnline?: boolean;
}

// === Messages ===

export enum MessageDirection {
  OUTGOING = 'OUTGOING',
  INCOMING = 'INCOMING',
}

export enum MessageType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  DOCUMENT = 'DOCUMENT',
  AUDIO = 'AUDIO',
  LOCATION = 'LOCATION',
  CONTACT = 'CONTACT',
  POLL = 'POLL',
  REACTION = 'REACTION',
}

export enum MessageStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  READ = 'READ',
  FAILED = 'FAILED',
}

export interface SendTextBody {
  chatId: string;
  message: string;
  quotedMessageId?: string;
}

export interface SendImageBody {
  chatId: string;
  image: string; // base64 or URL
  caption?: string;
}

export interface SendDocumentBody {
  chatId: string;
  document: string; // base64 or URL
  fileName: string;
  caption?: string;
}

export interface SendAudioBody {
  chatId: string;
  audio: string;
}

export interface SendLocationBody {
  chatId: string;
  latitude: number;
  longitude: number;
  name?: string;
}

export interface SendContactBody {
  chatId: string;
  contact: {
    name: string;
    phone: string;
  };
}

export interface SendPollBody {
  chatId: string;
  name: string;
  options: string[];
  multipleAnswers?: boolean;
}

export interface SendReactionBody {
  chatId: string;
  messageId: string;
  reaction: string; // emoji or empty string
}

export interface SendTypingBody {
  chatId: string;
  durationMs: number;
}

// === Send response ===

export interface SendMessageResponse {
  idMessage: string;
  status: string;
  timestamp: number;
}

// === Webhook ===

export interface WebhookPayload {
  typeWebhook: string;
  instanceData: {
    idInstance: string;
    phone: string;
  };
  timestamp: number;
  body: Record<string, unknown>;
}

// === Errors ===

export enum ErrorCode {
  INVALID_CHAT_ID = 'INVALID_CHAT_ID',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  INSTANCE_NOT_FOUND = 'INSTANCE_NOT_FOUND',
  INSTANCE_NOT_CONNECTED = 'INSTANCE_NOT_CONNECTED',
  QR_NOT_READY = 'QR_NOT_READY',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  SEND_FAILED = 'SEND_FAILED',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
}

export interface ApiError {
  error: ErrorCode;
  message: string;
  code: number;
}

// === Notifications (Polling) ===

export interface NotificationResponse {
  receiptId: number;
  body: WebhookPayload;
}

// === Chat ID validation ===

export const CHAT_ID_REGEX = /^\d+@(s\.whatsapp\.net|g\.us)$/;

export function isValidChatId(chatId: string): boolean {
  return CHAT_ID_REGEX.test(chatId);
}

export function phoneToJid(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}
