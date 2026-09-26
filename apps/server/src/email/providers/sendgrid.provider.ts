import type { EmailProvider, OutboundEmail } from '../email.types'

const SENDGRID_ENDPOINT = 'https://api.sendgrid.com/v3/mail/send'

/**
 * The production transport. Posts to SendGrid's v3 mail/send endpoint with
 * plain `fetch` — no SDK — so the only dependency is the standard library.
 *
 * Every non-2xx response rejects with the status and whatever body SendGrid
 * returned, because the dispatcher is what decides to retry, and it can only
 * do that if the failure is thrown.
 */
export class SendgridProvider implements EmailProvider {
  readonly name = 'sendgrid'
  readonly from: string
  private readonly apiKey: string

  constructor(apiKey: string, from: string) {
    if (apiKey.trim() === '') {
      throw new Error('SendgridProvider requires a non-empty API key')
    }
    if (from.trim() === '') {
      throw new Error('SendgridProvider requires a non-empty from address')
    }
    this.apiKey = apiKey
    this.from = from
  }

  async send(message: OutboundEmail): Promise<void> {
    const response = await fetch(SENDGRID_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: message.to }] }],
        from: { email: message.from },
        subject: message.subject,
        content: [{ type: 'text/html', value: message.html }],
      }),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`SendGrid responded ${String(response.status)}: ${body.slice(0, 500)}`)
    }
  }
}
