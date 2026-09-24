import { DomainError } from './domain-error'

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}
