CREATE TABLE `event_batches` (
	`user_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`claim_nonce` text NOT NULL,
	`status` text NOT NULL,
	`event_ids_json` text NOT NULL,
	`sync_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `batch_id`)
);
--> statement-breakpoint
CREATE TABLE `event_templates` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`shortcut` text NOT NULL,
	`title` text NOT NULL,
	`time` text NOT NULL,
	`duration_minutes` integer DEFAULT 60 NOT NULL,
	`recurrence` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_templates_by_user_shortcut` ON `event_templates` (`user_id`,`shortcut`);