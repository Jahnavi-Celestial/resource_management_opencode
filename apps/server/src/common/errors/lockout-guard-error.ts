import { DomainError } from './domain-error'

export class LockoutGuardError extends DomainError {
  constructor(message: string) {
    super(message)
    this.name = 'LockoutGuardError'
  }
}
