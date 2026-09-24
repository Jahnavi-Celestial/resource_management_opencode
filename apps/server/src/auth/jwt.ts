import * as jwt from 'jsonwebtoken'
import { loadEnv } from '../config/env'

export function signEmployeeToken(employeeId: string): string {
  const { jwt: jwtConfig } = loadEnv()
  return jwt.sign({ sub: employeeId }, jwtConfig.secret, {
    algorithm: 'HS256',
    expiresIn: jwtConfig.expiry as jwt.SignOptions['expiresIn'],
  })
}

export function verifyEmployeeToken(token: string | null | undefined): string | null {
  if (typeof token !== 'string' || token === '') return null
  const { jwt: jwtConfig } = loadEnv()
  try {
    const decoded = jwt.verify(token, jwtConfig.secret, { algorithms: ['HS256'] })
    if (typeof decoded === 'string') return null
    const subject = decoded.sub
    if (typeof subject !== 'string' || subject === '') return null
    return subject
  } catch {
    return null
  }
}
