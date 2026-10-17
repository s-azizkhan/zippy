ALTER TABLE "agents" ADD COLUMN "claude_account_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "claude_account_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_claude_account_id_claude_accounts_id_fk" FOREIGN KEY ("claude_account_id") REFERENCES "public"."claude_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_claude_account_id_claude_accounts_id_fk" FOREIGN KEY ("claude_account_id") REFERENCES "public"."claude_accounts"("id") ON DELETE set null ON UPDATE no action;