import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  uploadResumableMedia,
} from '@/lib/whatsapp/meta-api'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from '@/lib/flows/meta-send'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { supabaseAdmin } from './admin-client'

// ------------------------------------------------------------
// Automation-side Meta sender.
//
// Mirrors the logic in src/app/api/whatsapp/send/route.ts but uses
// the service-role client (engine has no cookies) and accepts the
// user / conversation / contact identifiers the engine already has
// on hand. Kept here (rather than refactoring the user-facing send
// route) to avoid risk to the working manual-send path — they can
// converge in a later refactor.
// ------------------------------------------------------------

interface SendTextArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so an automation authored by user A still sends through
   *  the WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the automation/flow — used for INSERT audit
   *  columns (messages.sender_id-ish) and for resolving the agent's
   *  identity in logs. Not consulted for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
}

interface SendTemplateArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  templateName: string
  language?: string
  params?: string[]
}

export async function engineSendText(args: SendTextArgs): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'text' })
}

export async function engineSendTemplate(
  args: SendTemplateArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'template' })
}

interface SendImageArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  /** Publicly reachable URL of the image (https, jpeg/png/webp). */
  imageUrl: string
  /** Optional caption rendered as text under the image (same bubble). */
  caption?: string
}

/**
 * Send a single image message from the automation engine.
 *
 * Mirrors `engineSendText`'s account-scoped lookup + phone-variant
 * retry, but posts to the media endpoint. The image URL must be
 * publicly reachable by Meta's servers. The optional `caption` is
 * the text that appears under the image in the same WhatsApp bubble.
 */
export async function engineSendImage(
  args: SendImageArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', args.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  // Diagnostic dump so we can see why a send might look successful in
  // the DB but never reach the recipient. The user reported the inbox
  // showing the message but WhatsApp not delivering — usually means
  // Meta's downstream queue dropped it (24h session closed, quality
  // rating, etc.) without raising an error to our HTTP call. Log
  // everything we know so we can pin it down from the server logs.
  console.log(
    `[automations] engineSendImage to=${sanitized} phone_number_id=${config.phone_number_id} url=${args.imageUrl.slice(0, 120)} caption_len=${args.caption?.length ?? 0}`,
  )

  // Meta rejects image/webp in image messages with error 131053
  // ("WebP image uploads are not currently supported"). Detect the
  // format from the URL's response and, if it's WebP, convert to JPEG
  // with sharp and Resumable-Upload the result so Meta gets a
  // pre-approved JPEG handle instead of fetching the WebP URL itself.
  //
  // Skip the conversion when the URL is already JPEG/PNG — most
  // callers don't need the extra fetch+upload round trip.
  const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/jpg'])
  let mediaHandle: string | undefined
  let useOriginalLink = true
  let responseForProbe: Response | null = null

  // SSRF guard: the URL is account-controlled (template or
  // webhook-derived); we fetch it server-side. Mirror the same check
  // we use for send_webhook so a poisoned URL can't bounce us into a
  // private network.
  if (!(await isDeliverableUrl(args.imageUrl))) {
    throw new Error(`engineSendImage: destination not allowed: ${args.imageUrl}`)
  }

  try {
    const probe = await fetch(args.imageUrl, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000),
    })
    responseForProbe = probe
  } catch {
    // HEAD may be blocked; ignore — we'll fall through to a plain
    // link-based send (Meta will still try and tell us via the
    // status webhook if the format is wrong).
    responseForProbe = null
  }

  const ct = (responseForProbe?.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (ct && !ALLOWED.has(ct)) {
    // Not JPEG/PNG — try to convert. Sharp accepts JPEG/PNG/WebP/GIF.
    const appId = process.env.META_APP_ID
    if (!appId) {
      throw new Error(
        `engineSendImage: image is ${ct || 'unknown format'} but Meta only accepts JPEG/PNG. Set META_APP_ID in the environment so we can Resumable-Upload a converted JPEG.`,
      )
    }
    try {
      const sharp = (await import('sharp')).default
      // Full GET — sharp needs the bytes, HEAD just gave us the type.
      const fullRes = await fetch(args.imageUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      })
      if (!fullRes.ok) {
        throw new Error(`image fetch returned ${fullRes.status}`)
      }
      const ab = await fullRes.arrayBuffer()
      const jpegBuf = await sharp(Buffer.from(ab))
        // .jpeg() defaults to quality=80 — fine for WhatsApp images
        // (the platform re-encodes anyway).
        .jpeg({ quality: 85 })
        .toBuffer()
      const { handle } = await uploadResumableMedia({
        appId,
        accessToken,
        fileName: 'image.jpg',
        mimeType: 'image/jpeg',
        bytes: jpegBuf,
      })
      mediaHandle = handle
      useOriginalLink = false
      console.log(
        `[automations] engineSendImage converted ${ct} → image/jpeg (${jpegBuf.byteLength} bytes), handle=${handle}`,
      )
    } catch (err) {
      console.warn(
        `[automations] engineSendImage conversion failed: ${err instanceof Error ? err.message : String(err)}. Falling back to original link.`,
      )
    }
  }

  const attempt = async (phone: string): Promise<string> => {
    const r = await sendMediaMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      kind: 'image',
      ...(useOriginalLink
        ? { link: args.imageUrl }
        : { id: mediaHandle! }),
      caption: args.caption || undefined,
    })
    console.log(
      `[automations] engineSendImage ok phone=${phone} message_id=${r.messageId} via=${useOriginalLink ? 'link' : 'handle'}`,
    )
    return r.messageId
  }

  const variants = phoneVariants(sanitized)
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: 'image',
    content_text: args.caption ?? null,
    media_url: args.imageUrl,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(`sent image to Meta but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: args.caption ? `[image] ${args.caption}` : '[image]',
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)

  return { whatsapp_message_id: waMessageId }
}

interface SendInteractiveArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  payload: InteractiveMessagePayload
}

/**
 * Send an interactive (reply-buttons or list) message from the
 * automation engine.
 *
 * Delegates to the Flows interactive senders
 * (`engineSendInteractiveButtons` / `engineSendInteractiveList`), which
 * already own the account-scoped lookup, phone-variant retry, and the
 * `messages` insert with `interactive_payload` + `sender_type='bot'`.
 * Both engines want identical behaviour here, so there's one
 * implementation rather than a second hand-rolled copy that could drift.
 */
export async function engineSendInteractive(
  args: SendInteractiveArgs,
): Promise<{ whatsapp_message_id: string }> {
  const { payload, accountId, userId, conversationId, contactId } = args
  const common = { accountId, userId, conversationId, contactId }
  if (payload.kind === 'buttons') {
    return engineSendInteractiveButtons({
      ...common,
      bodyText: payload.body,
      headerText: payload.header,
      footerText: payload.footer,
      buttons: payload.buttons,
    })
  }
  return engineSendInteractiveList({
    ...common,
    bodyText: payload.body,
    buttonLabel: payload.button_label,
    headerText: payload.header,
    footerText: payload.footer,
    sections: payload.sections,
  })
}

type SendInput =
  | (SendTextArgs & { kind: 'text' })
  | (SendTemplateArgs & { kind: 'template' })

async function sendViaMeta(input: SendInput): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  // Scope the contact + config lookups by account_id, not user_id.
  // The engine uses the service-role client (bypassing RLS); without
  // this filter, an authenticated user could fire their own
  // automations against another tenant's contact UUID and send via
  // their own WhatsApp config to that contact's phone. The 017
  // migration moved both tables to account-scoped tenancy, so the
  // check is the same defense-in-depth as before, just keyed on the
  // new tenancy column.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  const { data: config, error: configErr } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', input.accountId)
    .single()
  if (configErr || !config) {
    throw new Error('WhatsApp not configured for this account')
  }

  const accessToken = decrypt(config.access_token)

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'template') {
      const r = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: input.templateName,
        language: input.language,
        params: input.params,
      })
      return r.messageId
    }
    const r = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: input.text,
    })
    return r.messageId
  }

  // Same phone-variant retry as /api/whatsapp/send — Meta sandbox and
  // numbers registered with/without a trunk 0 both require this to
  // reliably land a message.
  const variants = phoneVariants(sanitized)
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[automations] sendViaMeta variant ${v} failed: ${msg.slice(0, 300)}`,
      )
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }

  if (workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  // Persist the sent message so it appears in the inbox with a real
  // Meta message id. sender_type='bot' distinguishes automation sends
  // from manual agent sends.
  const content_type = input.kind === 'template' ? 'template' : 'text'
  const content_text = input.kind === 'text' ? input.text : null
  const template_name = input.kind === 'template' ? input.templateName : null

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type,
    content_text,
    template_name,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    // Meta already has the message; record the DB error but don't pretend
    // the send failed. The engine wraps this in a log line.
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text:
        input.kind === 'template' ? `[template:${input.templateName}]` : input.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId)

  return { whatsapp_message_id: waMessageId }
}
