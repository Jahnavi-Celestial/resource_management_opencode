import { type MigrationInterface, type QueryRunner } from 'typeorm'

export class AddEquipmentNameUniqueCaseInsensitive1790176946848 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_equipment_name" ON "equipment" (LOWER(name))`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "uq_equipment_name"`)
  }
}
