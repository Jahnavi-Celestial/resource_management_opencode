import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'

function findEnvFile(): string | undefined {
  let dir = process.cwd()
  for (let depth = 0; depth < 4; depth++) {
    const candidate = path.join(dir, '.env')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

const envFile = findEnvFile()
if (envFile) {
  dotenv.config({ path: envFile, quiet: true })
}

export type NodeEnv = 'development' | 'test' | 'production'

export interface Env {
  nodeEnv: NodeEnv
  port: number
  wsPort: number
  db: {
    host: string
    port: number
    username: string
    password: string
    name: string
  }
  jwt: {
    secret: string
    expiry: string
  }
  sendgrid: {
    apiKey: string
    emailFrom: string
  }
  email: {
    dispatchCron: string
    maxAttempts: number
  }
  /** S10 cron cadence, shared by the two booking-clock jobs (see PLAN.md #10). */
  bookingJobsCron: string
  rejectionReasonMinLength: number
  reminderLeadTimeMinutes: number
  admin: {
    email: string
    password: string
  }
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value.trim()
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') return fallback
  return value.trim()
}

function requiredInt(name: string, fallback?: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') {
    if (fallback === undefined) {
      throw new Error(`Missing required environment variable: ${name}`)
    }
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got: ${raw}`)
  }
  return parsed
}

let cached: Env | undefined

export function loadEnv(): Env {
  if (cached) return cached

  const nodeEnvRaw = optional('NODE_ENV', 'development')
  if (nodeEnvRaw !== 'development' && nodeEnvRaw !== 'test' && nodeEnvRaw !== 'production') {
    throw new Error(`NODE_ENV must be one of development|test|production, got: ${nodeEnvRaw}`)
  }

  if (nodeEnvRaw === 'production' && (process.env.ADMIN_PASSWORD ?? '').trim() === '') {
    throw new Error('ADMIN_PASSWORD must be set explicitly when NODE_ENV=production')
  }

  cached = {
    nodeEnv: nodeEnvRaw,
    port: requiredInt('PORT', 4000),
    wsPort: requiredInt('WS_PORT', 4001),
    db: {
      host: required('DB_HOST'),
      port: requiredInt('DB_PORT', 5432),
      username: required('DB_USERNAME'),
      password: required('DB_PASSWORD'),
      name: required('DB_NAME'),
    },
    jwt: {
      secret: required('JWT_SECRET'),
      expiry: optional('JWT_EXPIRY', '1h'),
    },
    sendgrid: {
      apiKey: optional('SENDGRID_API_KEY', ''),
      emailFrom: optional('EMAIL_FROM', ''),
    },
    email: {
      dispatchCron: optional('EMAIL_DISPATCH_CRON', '* * * * *'),
      maxAttempts: requiredInt('EMAIL_MAX_ATTEMPTS', 5),
    },
    bookingJobsCron: optional('BOOKING_JOBS_CRON', '*/5 * * * *'),
    rejectionReasonMinLength: requiredInt('REJECTION_REASON_MIN_LENGTH', 10),
    reminderLeadTimeMinutes: requiredInt('REMINDER_LEAD_TIME_MINUTES', 60),
    admin: {
      email: optional('ADMIN_EMAIL', 'admin@resource.local').toLowerCase(),
      password: optional('ADMIN_PASSWORD', 'Admin@12345!'),
    },
  }

  return cached
}
