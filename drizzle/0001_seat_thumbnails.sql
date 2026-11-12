CREATE TABLE "seat_thumbnails" (
	"room_id" text NOT NULL,
	"unit" integer NOT NULL,
	"jpeg" "bytea" NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seat_thumbnails_room_id_unit_pk" PRIMARY KEY("room_id","unit")
);
--> statement-breakpoint
ALTER TABLE "seat_thumbnails" ADD CONSTRAINT "seat_thumbnails_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;