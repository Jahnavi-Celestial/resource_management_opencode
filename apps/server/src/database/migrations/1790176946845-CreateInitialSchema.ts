import { type MigrationInterface, type QueryRunner } from 'typeorm'

export class CreateInitialSchema1790176946845 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "btree_gist"`)
    await queryRunner.query(`CREATE TYPE "booking_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'COMPLETED')`)
    await queryRunner.query(`CREATE TYPE "audit_action" AS ENUM('CREATE', 'APPROVE', 'REJECT', 'CANCEL', 'COMPLETE')`)
    await queryRunner.query(`CREATE TYPE "notification_type" AS ENUM('BOOKING_PENDING', 'BOOKING_APPROVED', 'BOOKING_REJECTED', 'BOOKING_CANCELLED', 'REMINDER')`)
    await queryRunner.query(`CREATE TYPE "email_outbox_status" AS ENUM('PENDING', 'SENT', 'FAILED')`)

    await queryRunner.query(`
      CREATE TABLE "employee" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "first_name" text NOT NULL,
        "last_name" text NOT NULL,
        "email" text NOT NULL,
        "password" text NOT NULL,
        "created_at" timestamp with time zone NOT NULL DEFAULT now(),
        "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
        PRIMARY KEY ("id")
      )
    `)
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_employee_email" ON "employee" ("email")`)

    await queryRunner.query(`
      CREATE TABLE "role" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "role_name" text NOT NULL,
        PRIMARY KEY ("id")
      )
    `)
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_role_role_name" ON "role" ("role_name")`)

    await queryRunner.query(`
      CREATE TABLE "permission" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "permission_name" text NOT NULL,
        PRIMARY KEY ("id")
      )
    `)
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_permission_permission_name" ON "permission" ("permission_name")`)

    await queryRunner.query(`
      CREATE TABLE "user_role" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "employee_id" uuid NOT NULL,
        "role_id" uuid NOT NULL,
        PRIMARY KEY ("id"),
        CONSTRAINT "fk_user_role_employee_id" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE NO ACTION NOT DEFERRABLE,
        CONSTRAINT "fk_user_role_role_id" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE NO ACTION NOT DEFERRABLE
      )
    `)
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_user_role_employee_id_role_id" ON "user_role" ("employee_id", "role_id")`)
    await queryRunner.query(`CREATE INDEX "idx_user_role_role_id" ON "user_role" ("role_id")`)

    await queryRunner.query(`
      CREATE TABLE "role_permission" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "role_id" uuid NOT NULL,
        "permission_id" uuid NOT NULL,
        PRIMARY KEY ("id"),
        CONSTRAINT "fk_role_permission_role_id" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE NO ACTION NOT DEFERRABLE,
        CONSTRAINT "fk_role_permission_permission_id" FOREIGN KEY ("permission_id") REFERENCES "permission"("id") ON DELETE CASCADE ON UPDATE NO ACTION NOT DEFERRABLE
      )
    `)
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_role_permission_role_id_permission_id" ON "role_permission" ("role_id", "permission_id")`)
    await queryRunner.query(`CREATE INDEX "idx_role_permission_permission_id" ON "role_permission" ("permission_id")`)

    await queryRunner.query(`
      CREATE TABLE "meeting_room" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" text NOT NULL,
        "location" text NOT NULL,
        "capacity" integer NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamp with time zone NOT NULL DEFAULT now(),
        "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
        PRIMARY KEY ("id")
      )
    `)

    await queryRunner.query(`
      CREATE TABLE "equipment" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" text NOT NULL,
        "quantity_available" integer NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamp with time zone NOT NULL DEFAULT now(),
        "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
        PRIMARY KEY ("id")
      )
    `)

    await queryRunner.query(`
      CREATE TABLE "booking" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "employee_id" uuid,
        "room_id" uuid NOT NULL,
        "start_time" timestamp with time zone NOT NULL,
        "end_time" timestamp with time zone NOT NULL,
        "purpose" text NOT NULL,
        "rejection_reason" text,
        "number_of_attendees" integer NOT NULL,
        "status" "booking_status" NOT NULL,
        "created_at" timestamp with time zone NOT NULL DEFAULT now(),
        "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
        PRIMARY KEY ("id"),
        CONSTRAINT "fk_booking_employee_id" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE SET NULL ON UPDATE NO ACTION NOT DEFERRABLE,
        CONSTRAINT "fk_booking_room_id" FOREIGN KEY ("room_id") REFERENCES "meeting_room"("id") ON DELETE RESTRICT ON UPDATE NO ACTION NOT DEFERRABLE,
        CONSTRAINT "chk_booking_end_after_start" CHECK ("end_time" > "start_time"),
        CONSTRAINT "chk_booking_number_of_attendees_positive" CHECK ("number_of_attendees" > 0)
      )
    `)
    await queryRunner.query(`CREATE INDEX "idx_booking_start_time_end_time" ON "booking" ("start_time", "end_time")`)
    await queryRunner.query(`CREATE INDEX "idx_booking_status" ON "booking" ("status")`)
    await queryRunner.query(`CREATE INDEX "idx_booking_employee_id" ON "booking" ("employee_id")`)
    await queryRunner.query(`CREATE INDEX "idx_booking_room_id" ON "booking" ("room_id")`)

    await queryRunner.query(`
      CREATE TABLE "booking_equipment" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "booking_id" uuid NOT NULL,
        "equipment_id" uuid NOT NULL,
        "quantity" integer NOT NULL,
        PRIMARY KEY ("id"),
        CONSTRAINT "fk_booking_equipment_booking_id" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE CASCADE ON UPDATE NO ACTION NOT DEFERRABLE,
        CONSTRAINT "fk_booking_equipment_equipment_id" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON DELETE RESTRICT ON UPDATE NO ACTION NOT DEFERRABLE,
        CONSTRAINT "chk_booking_equipment_quantity_positive" CHECK ("quantity" > 0)
      )
    `)
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_booking_equipment_booking_id_equipment_id" ON "booking_equipment" ("booking_id", "equipment_id")`)
    await queryRunner.query(`CREATE INDEX "idx_booking_equipment_equipment_id" ON "booking_equipment" ("equipment_id")`)

    await queryRunner.query(`
      CREATE TABLE "audit_log" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "booking_id" uuid NOT NULL,
        "action" "audit_action" NOT NULL,
        "old_status" "booking_status",
        "new_status" "booking_status" NOT NULL,
        "performed_by" uuid,
        "created_at" timestamp with time zone NOT NULL DEFAULT now(),
        PRIMARY KEY ("id"),
        CONSTRAINT "fk_audit_log_booking_id" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE NO ACTION NOT DEFERRABLE,
        CONSTRAINT "fk_audit_log_performed_by" FOREIGN KEY ("performed_by") REFERENCES "employee"("id") ON DELETE SET NULL ON UPDATE NO ACTION NOT DEFERRABLE
      )
    `)
    await queryRunner.query(`CREATE INDEX "idx_audit_log_booking_id" ON "audit_log" ("booking_id")`)
    await queryRunner.query(`CREATE INDEX "idx_audit_log_performed_by" ON "audit_log" ("performed_by")`)

    await queryRunner.query(`
      CREATE TABLE "notification" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "recipient_id" uuid NOT NULL,
        "booking_id" uuid NOT NULL,
        "type" "notification_type" NOT NULL,
        "title" text NOT NULL,
        "message" text NOT NULL,
        "is_read" boolean NOT NULL DEFAULT false,
        "created_at" timestamp with time zone NOT NULL DEFAULT now(),
        PRIMARY KEY ("id"),
        CONSTRAINT "fk_notification_recipient_id" FOREIGN KEY ("recipient_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE NO ACTION NOT DEFERRABLE,
        CONSTRAINT "fk_notification_booking_id" FOREIGN KEY ("booking_id") REFERENCES "booking"("id") ON DELETE RESTRICT ON UPDATE NO ACTION NOT DEFERRABLE
      )
    `)
    await queryRunner.query(`CREATE UNIQUE INDEX "uq_notification_booking_recipient_type" ON "notification" ("booking_id", "recipient_id", "type")`)
    await queryRunner.query(`CREATE INDEX "idx_notification_recipient_id" ON "notification" ("recipient_id")`)

    await queryRunner.query(`
      CREATE TABLE "email_outbox" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "to_email" text NOT NULL,
        "subject" text NOT NULL,
        "html" text NOT NULL,
        "event_type" text NOT NULL,
        "status" "email_outbox_status" NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "next_attempt_at" timestamp with time zone,
        "last_error" text,
        "created_at" timestamp with time zone NOT NULL DEFAULT now(),
        "sent_at" timestamp with time zone,
        PRIMARY KEY ("id")
      )
    `)
    await queryRunner.query(`CREATE INDEX "idx_email_outbox_status_next_attempt_at" ON "email_outbox" ("status", "next_attempt_at")`)

    await queryRunner.query(`
      ALTER TABLE "booking" ADD CONSTRAINT "ex_booking_room_time_range" EXCLUDE USING gist (
        "room_id" WITH =,
        tstzrange("start_time", "end_time", '[)') WITH &&
      ) WHERE ("status" IN ('PENDING', 'APPROVED'))
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "email_outbox"`)
    await queryRunner.query(`DROP TABLE "notification"`)
    await queryRunner.query(`DROP TABLE "audit_log"`)
    await queryRunner.query(`DROP TABLE "booking_equipment"`)
    await queryRunner.query(`DROP TABLE "booking"`)
    await queryRunner.query(`DROP TABLE "equipment"`)
    await queryRunner.query(`DROP TABLE "meeting_room"`)
    await queryRunner.query(`DROP TABLE "role_permission"`)
    await queryRunner.query(`DROP TABLE "user_role"`)
    await queryRunner.query(`DROP TABLE "permission"`)
    await queryRunner.query(`DROP TABLE "role"`)
    await queryRunner.query(`DROP TABLE "employee"`)
    await queryRunner.query(`DROP TYPE "email_outbox_status"`)
    await queryRunner.query(`DROP TYPE "notification_type"`)
    await queryRunner.query(`DROP TYPE "audit_action"`)
    await queryRunner.query(`DROP TYPE "booking_status"`)
    await queryRunner.query(`DROP EXTENSION IF EXISTS "btree_gist"`)
  }
}
