import { DomainError } from './domain-error'

export class SystemRoleError extends DomainError {
  constructor(message: string) {
    super(message)
    this.name = 'SystemRoleError'
  }
}
