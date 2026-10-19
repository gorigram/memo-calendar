ALTER TABLE `events` ADD `type` text DEFAULT 'schedule' NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `due_date` text;--> statement-breakpoint
ALTER TABLE `events` ADD `due_time` text;--> statement-breakpoint
ALTER TABLE `events` ADD `completed` integer DEFAULT 0 NOT NULL;