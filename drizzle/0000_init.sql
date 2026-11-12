CREATE TABLE "cameras" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"driver" text NOT NULL,
	"host" text DEFAULT '' NOT NULL,
	"port" integer,
	"role" text NOT NULL,
	"ndi_source" text DEFAULT '' NOT NULL,
	"settle_ms" integer DEFAULT 2500 NOT NULL,
	"home_preset" text,
	"credentials_ref" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"dcen_host" text DEFAULT '' NOT NULL,
	"dcen_port" integer DEFAULT 3225 NOT NULL,
	"output_name" text NOT NULL,
	"output_mode" text DEFAULT 'route' NOT NULL,
	"policy" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seats" (
	"room_id" text NOT NULL,
	"unit" integer NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"camera_id" text NOT NULL,
	"preset" text,
	CONSTRAINT "seats_room_id_unit_pk" PRIMARY KEY("room_id","unit")
);
--> statement-breakpoint
ALTER TABLE "cameras" ADD CONSTRAINT "cameras_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_camera_id_cameras_id_fk" FOREIGN KEY ("camera_id") REFERENCES "public"."cameras"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cameras_room_idx" ON "cameras" USING btree ("room_id");