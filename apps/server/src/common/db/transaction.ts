import type { DataSource, EntityManager } from 'typeorm'

export type AfterCommitCallback = () => void | Promise<void>

export interface TransactionalEntityManager extends EntityManager {
  afterCommit(callback: AfterCommitCallback): void
}

export async function runInTransaction<T>(
  dataSource: DataSource,
  fn: (tx: TransactionalEntityManager) => Promise<T>,
): Promise<T> {
  const callbacks: AfterCommitCallback[] = []
  const result = await dataSource.transaction(async (manager) => {
    const tx = manager as TransactionalEntityManager
    tx.afterCommit = (callback: AfterCommitCallback): void => {
      callbacks.push(callback)
    }
    return fn(tx)
  })
  for (const callback of callbacks) {
    await callback()
  }
  return result
}
