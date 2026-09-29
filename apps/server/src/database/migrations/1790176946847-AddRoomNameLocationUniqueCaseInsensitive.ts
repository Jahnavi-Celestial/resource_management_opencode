import { type MigrationInterface, type QueryRunner } from 'typeorm'

export class AddRoomNameLocationUniqueCaseInsensitive1790176946847 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "uq_room_name_location"`)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_room_name_location" ON "meeting_room" (LOWER(name), LOWER(location))`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "uq_room_name_location"`)
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_room_name_location" ON "meeting_room" ("name", "location")`)
  }
}
