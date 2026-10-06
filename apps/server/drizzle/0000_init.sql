CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"acp_session_id" text,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"tokens_cache_read" integer DEFAULT 0 NOT NULL,
	"tokens_cache_write" integer DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"ctx_tokens" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"handle" text NOT NULL,
	"role_prompt_md" text DEFAULT '' NOT NULL,
	"model" text DEFAULT 'default' NOT NULL,
	"effort" text DEFAULT 'default' NOT NULL,
	"can_write" boolean DEFAULT false NOT NULL,
	"color" text DEFAULT '#6366f1' NOT NULL,
	"toggles" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"agent_id" uuid,
	"parent_id" uuid,
	"linear_comment_id" text,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"agent_id" uuid,
	"ticket_id" uuid,
	"uses" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#6b7280' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"name" text NOT NULL,
	"transport" text NOT NULL,
	"command" text DEFAULT '' NOT NULL,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"context_md" text DEFAULT '' NOT NULL,
	"default_model" text DEFAULT 'default' NOT NULL,
	"default_effort" text DEFAULT 'default' NOT NULL,
	"cache_ttl" text DEFAULT '5m' NOT NULL,
	"idle_minutes" integer DEFAULT 10 NOT NULL,
	"max_live" integer DEFAULT 0 NOT NULL,
	"ticket_seq" integer DEFAULT 0 NOT NULL,
	"toggles" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"budget_usd" real,
	"linear_auth" jsonb,
	"linear_workspace" text,
	"linear_push" boolean DEFAULT true NOT NULL,
	"profile" jsonb DEFAULT '{"name":"","handle":"","role":"","githubUsername":"","githubEmail":"","linearUser":"","about":"","dayStart":"00:00"}'::jsonb NOT NULL,
	"slack_webhook_url" text DEFAULT '' NOT NULL,
	"notify_desktop" boolean DEFAULT true NOT NULL,
	"use_active_branch" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"instruction" text DEFAULT '' NOT NULL,
	"on_pass" text DEFAULT 'next' NOT NULL,
	"on_fail" text DEFAULT 'human' NOT NULL,
	"human_gate" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"auto_start" boolean DEFAULT false NOT NULL,
	"max_loops" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"workspace_ids" uuid[] DEFAULT '{}' NOT NULL,
	"assignee_agent_id" uuid,
	"pipeline_id" uuid,
	"every_hours" integer DEFAULT 24 NOT NULL,
	"run_at" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_session_id" uuid NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"tokens_cache_read" integer DEFAULT 0 NOT NULL,
	"tokens_cache_write" integer DEFAULT 0 NOT NULL,
	"ctx_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_folders" (
	"ticket_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"worktree_path" text,
	"branch" text,
	"pr_url" text,
	"pr_title" text,
	"pr_state" text,
	"ci_handled_sha" text,
	"review_seen_at" timestamp with time zone,
	CONSTRAINT "ticket_folders_ticket_id_workspace_id_pk" PRIMARY KEY("ticket_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"assignee_agent_id" uuid,
	"assignee_human" boolean DEFAULT false NOT NULL,
	"identifier" text NOT NULL,
	"kind" text DEFAULT 'ticket' NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"priority" text DEFAULT 'none' NOT NULL,
	"label_ids" uuid[] DEFAULT '{}' NOT NULL,
	"linear_id" text,
	"linear_url" text,
	"pipeline_id" uuid,
	"stage_id" uuid,
	"loop_count" integer DEFAULT 0 NOT NULL,
	"risk_approved" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"parent_id" uuid,
	"routine_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "todos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"day" text NOT NULL,
	"title" text NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"ref" text DEFAULT '' NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"base_branch" text DEFAULT 'main' NOT NULL,
	"setup_cmd" text DEFAULT '' NOT NULL,
	"test_cmd" text DEFAULT '' NOT NULL,
	"context_md" text DEFAULT '' NOT NULL,
	"risk_paths" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge" ADD CONSTRAINT "knowledge_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge" ADD CONSTRAINT "knowledge_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge" ADD CONSTRAINT "knowledge_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge" ADD CONSTRAINT "knowledge_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_folders" ADD CONSTRAINT "ticket_folders_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_folders" ADD CONSTRAINT "ticket_folders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_ticket_agent" ON "agent_sessions" USING btree ("ticket_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_org_handle" ON "agents" USING btree ("org_id","handle");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_org_identifier" ON "tickets" USING btree ("org_id","identifier");