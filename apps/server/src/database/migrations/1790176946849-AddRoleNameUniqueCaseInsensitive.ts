import { type MigrationInterface, type QueryRunner } from 'typeorm'

export class AddRoleNameUniqueCaseInsensitive1790176946849 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // The index is expression-based (LOWER(role_name)), so a plain GROUP BY
    // cannot find the rows that would collide under it. Self-join on the
    // folded name instead, and fail loudly: creating the index over existing
    // case-variant duplicates would abort the migration halfway and leave the
    // schema without any unique index on role_name at all.
    const duplicates: Array<{ role_name: string }> = await queryRunner.query(
      `SELECT a.role_name
         FROM "role" a
         JOIN "role" b ON LOWER(a.role_name) = LOWER(b.role_name) AND a.id <> b.id
        GROUP BY a.role_name`,
    )
    if (duplicates.length > 0) {
      throw new Error(
        `Cannot create case-insensitive role name index: existing roles differ only by case: ${duplicates
          .map((row) => row.role_name)
          .join(', ')}`,
      )
    }
    await queryRunner.query(`DROP INDEX "uq_role_role_name"`)
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_role_role_name" ON "role" (LOWER(role_name))`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "uq_role_role_name"`)
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_role_role_name" ON "role" ("role_name")`)
  }
}
