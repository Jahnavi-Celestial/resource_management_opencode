/**
 * TypeORM 0.3.20's schema builder honours `synchronize: false` on index
 * metadata (it skips both creating and dropping the index), but the option is
 * missing from the package's own `IndexOptions` types. Entities use it for
 * indexes migrations own — expression indexes TypeORM cannot declare, such as
 * the case-insensitive unique indexes on room and equipment names.
 */
export {}

declare module 'typeorm/decorator/options/IndexOptions' {
  interface IndexOptions {
    /**
     * When false, schema sync leaves the index alone: neither creates it nor
     * drops the database's existing one. For indexes whose DDL lives in a
     * migration because the decorator cannot express it.
     */
    synchronize?: boolean
  }
}
