CREATE TABLE `administrator` (
	`id` integer PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`salt` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "single_admin" CHECK("administrator"."id"=1)
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text,
	`action` text NOT NULL,
	`description` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_student_date` ON `audit_log` (`student_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `lessons` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`lesson_date` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`voided_at` text,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "active_flag" CHECK("lessons"."active" IN (0,1))
);
--> statement-breakpoint
CREATE INDEX `student_lesson_date` ON `lessons` (`student_id`,`lesson_date`);--> statement-breakpoint
CREATE TABLE `request_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `admin_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `session_expiry` ON `admin_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `students` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`class_name` text NOT NULL,
	`balance` integer NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "nonnegative_balance" CHECK("students"."balance">=0 AND "students"."balance"<=9999)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `students_code_unique` ON `students` (`code`);--> statement-breakpoint
CREATE INDEX `student_name_lookup` ON `students` (`name_key`);