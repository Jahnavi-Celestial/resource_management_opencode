import type { Env } from '../../config/env'
import type { EmailProvider } from '../email.types'
import { NoopProvider } from './noop.provider'
import { SendgridProvider } from './sendgrid.provider'

/**
 * Provider selection is config-driven and fails loudly rather than silently
 * degrading.
 *
 * - no `SENDGRID_API_KEY` -> noop. This is the local-dev default (the checked
 *   .env leaves the key empty), so a developer never needs an account.
 * - `NODE_ENV=production` without a key is a hard error at boot: silently
 *   running noop in production would mark every email SENT while delivering
 *   nothing, which is worse than not starting.
 */
export function createEmailProvider(env: Env): EmailProvider {
  const apiKey = env.sendgrid.apiKey
  const from = env.sendgrid.emailFrom
  if (apiKey !== '' && from !== '') {
    return new SendgridProvider(apiKey, from)
  }
  if (env.nodeEnv === 'production') {
    throw new Error('SENDGRID_API_KEY and EMAIL_FROM must both be set when NODE_ENV=production')
  }
  return new NoopProvider(from !== '' ? from : undefined)
}
