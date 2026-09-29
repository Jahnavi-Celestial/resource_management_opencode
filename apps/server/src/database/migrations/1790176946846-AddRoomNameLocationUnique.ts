import { type MigrationInterface, type QueryRunner } from 'typeorm'

export class AddRoomNameLocationUnique1790176946846 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_room_name_location" ON "meeting_room" ("name", "location")`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "uq_room_name_location"`)
  }
}
