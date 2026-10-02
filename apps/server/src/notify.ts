import { execFile } from "node:child_process";
import type { orgs, tickets } from "./db/index.ts";

const WEB = () => process.env.WEB_URL ?? "http://localhost:5199";

/** Desktop (macOS) and Slack ping when a ticket needs the user. Failures are logged, never thrown. */
export async function notify(org: typeof orgs.$inferSelect, ticket: typeof tickets.$inferSelect, what: string) {
  const title = `${ticket.identifier} ${what}`;
  if (org.notifyDesktop && process.platform === "darwin") {
    // Text goes in argv, never in the script, so ticket titles cannot inject AppleScript.
    execFile("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, ticket.title], (e) => e && console.error("[notify]", e.message));
  }
  if (org.slackWebhookUrl) {
    const res = await fetch(org.slackWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `*${title}*: <${WEB()}/t/${ticket.identifier}|${ticket.title.replace(/[<>|]/g, "")}>` }),
    }).catch((e: Error) => ({ ok: false, statusText: e.message }));
    if (!res.ok) console.error("[notify] slack", res.statusText);
  }
}
