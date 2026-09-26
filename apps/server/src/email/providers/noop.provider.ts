import type { EmailProvider, OutboundEmail } from '../email.types'

export const NOOP_FROM = 'no-reply@resource.local'

/**
 * The local-development transport (PLAN assumption #3's "no-op provider").
 *
 * It succeeds, so the outbox row reaches SENT and the rest of the pipeline
 * behaves exactly as it will in production — but nothing leaves the machine.
 * Every "sent" message is retained in `sent` so a developer can see what would
 * have gone out, and so a test can assert delivery without a network call.
 */
export class NoopProvider implements EmailProvider {
  readonly name = 'noop'
  readonly from: string
  readonly sent: OutboundEmail[] = []

  constructor(from: string = NOOP_FROM) {
    this.from = from
  }

  async send(message: OutboundEmail): Promise<void> {
    this.sent.push(message)
    console.log(
      `[email] noop provider "sent" "${message.subject}" to ${message.to} (outbox ${message.outboxId})`,
    )
  }
}
