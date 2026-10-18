CREATE TABLE `events` (
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`start` text NOT NULL,
	`end` text NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`recurrence` text DEFAULT '[]' NOT NULL,
	`google_event_id` text,
	`synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `events_by_user_start` ON `events` (`user_id`,`start`);--> statement-breakpoint
CREATE TABLE `google_tokens` (
	`user_id` text PRIMARY KEY NOT NULL,
	`refresh_token_enc` text NOT NULL,
	`access_token_enc` text,
	`access_expires` integer,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`code_verifier` text NOT NULL,
	`expires_at` integer NOT NULL,
	`owner_id` text
);
--> statement-breakpoint
CREATE INDEX `oauth_states_expiry` ON `oauth_states` (`expires_at`);