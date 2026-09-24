export const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password'

export class InvalidCredentialsError extends Error {
  constructor() {
    super(INVALID_CREDENTIALS_MESSAGE)
    this.name = 'InvalidCredentialsError'
  }
}
