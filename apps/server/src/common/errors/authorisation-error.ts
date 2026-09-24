export const AUTHORISATION_ERROR_MESSAGE = 'Not authorised'

export class AuthorisationError extends Error {
  constructor() {
    super(AUTHORISATION_ERROR_MESSAGE)
    this.name = 'AuthorisationError'
  }
}
