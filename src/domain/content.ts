import type { Message } from 'grammy/types';

/** Media kinds the bot relays. Files are referenced by bot-scoped file_id, never downloaded. */
export const ATTACHMENT_TYPES = [
  'photo',
  'document',
  'video',
  'audio',
  'voice',
  'animation',
  'sticker',
  'video_note',
] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

/** Types whose send method accepts a caption (so the header fits in one message). */
export const CAPTIONED_TYPES: ReadonlySet<AttachmentType> = new Set([
  'photo',
  'document',
  'video',
  'audio',
  'voice',
  'animation',
]);

export type Attachment = { type: AttachmentType; fileId: string };
export type MessageContent = { text: string | null; attachment: Attachment | null };

export const MESSAGE_TEXT_MAX = 4000;

/** Extracts relayable content from a Telegram message, or null for unsupported kinds. */
export function extractContent(message: Message): MessageContent | null {
  const text = (message.text ?? message.caption ?? '').trim() || null;
  let attachment: Attachment | null = null;
  // `animation` messages also carry `document`; check it first.
  if (message.animation) attachment = { type: 'animation', fileId: message.animation.file_id };
  else if (message.photo?.length)
    attachment = { type: 'photo', fileId: message.photo[message.photo.length - 1]!.file_id };
  else if (message.document) attachment = { type: 'document', fileId: message.document.file_id };
  else if (message.video) attachment = { type: 'video', fileId: message.video.file_id };
  else if (message.audio) attachment = { type: 'audio', fileId: message.audio.file_id };
  else if (message.voice) attachment = { type: 'voice', fileId: message.voice.file_id };
  else if (message.sticker) attachment = { type: 'sticker', fileId: message.sticker.file_id };
  else if (message.video_note) attachment = { type: 'video_note', fileId: message.video_note.file_id };
  if (!text && !attachment) return null;
  return { text, attachment };
}

export type ContentValidation =
  { ok: true; content: MessageContent } | { ok: false; reason: 'empty' | 'too_long' | 'command' };

export function validateContent(content: MessageContent | null): ContentValidation {
  if (!content) return { ok: false, reason: 'empty' };
  if (!content.attachment && content.text?.startsWith('/')) return { ok: false, reason: 'command' };
  if (content.text && [...content.text].length > MESSAGE_TEXT_MAX)
    return { ok: false, reason: 'too_long' };
  return { ok: true, content };
}

export function isAttachmentType(value: unknown): value is AttachmentType {
  return typeof value === 'string' && (ATTACHMENT_TYPES as readonly string[]).includes(value);
}
