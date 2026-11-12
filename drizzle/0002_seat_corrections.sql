CREATE TABLE "seat_corrections" (
	"room_id" text NOT NULL,
	"unit" integer NOT NULL,
	"camera_id" text NOT NULL,
	"preset" text NOT NULL,
	"preset_pos" jsonb,
	"samples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seat_corrections_room_id_unit_pk" PRIMARY KEY("room_id","unit")
);
--> statement-breakpoint
ALTER TABLE "seat_corrections" ADD CONSTRAINT "seat_corrections_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;