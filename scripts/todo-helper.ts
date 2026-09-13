import * as fs from "fs";
import * as path from "path";

export interface PendingQueueItem {
  id: string;
  title?: string;
  slug?: string;
  author?: string;
  source?: string;
  _type?: string;
  inD1?: boolean;
  inHf?: boolean;
  queuedAt: string;
  failureReason?: string;
  lastRetryAt?: string;
  [key: string]: any;
}

export function writeTodoMarkdown(pending: PendingQueueItem[]): void {
  const rootTodo = path.join(process.cwd(), "todo.md");
  const docsTodo = path.join(process.cwd(), "docs", "public", "todo.md");

  const now = new Date().toISOString();
  let md = "# 📋 Pending Sync Queue (D1 & Hugging Face)\n\n";
  md += `> **Status**: ${pending.length === 0 ? "✅ All games synchronized" : `⏳ ${pending.length} item(s) pending sync`}\n`;
  md += `> **Last updated**: ${now}\n\n`;

  if (pending.length === 0) {
    md += "All discovered horror games have been successfully synchronized to both Cloudflare D1 and the Hugging Face master dataset (`aurostron/hogamegata`).\n";
  } else {
    md += "| # | Title / Item | Source | Type | In Hugging Face? | In D1? | Queued At | Last Error |\n";
    md += "|---|---|---|---|:---:|:---:|---|---|\n";

    pending.forEach((item, idx) => {
      const title = item.title || item.slug || item.id;
      const src = item.source || "itch";
      const type = item._type === "canonicalLink" ? "Canonical Link" : "Game";
      const hfBadge = item.inHf ? "✅ Yes" : "⏳ Pending";
      const d1Badge = item.inD1 ? "✅ Yes" : "❌ Pending/Quota";
      const queued = item.queuedAt ? item.queuedAt.slice(0, 19).replace("T", " ") : "N/A";
      const err = item.failureReason ? ``\`${item.failureReason.slice(0, 60)}\``` : "-";

      md += `| ${idx + 1} | **${title}** | ${src} | ${type} | ${hfBadge} | ${d1Badge} | ${queued} | ${err} |\n`;
    });

    md += "\n---\n*This queue is automatically monitored by `.github/workflows/retry-pending.yml` (every 6 hours) and `.github/workflows/generate-catalog-dump.yml` (weekly/on-demand).\n*";
  }

  try {
    fs.writeFileSync(rootTodo, md, "utf-8");
    fs.mkdirSync(path.dirname(docsTodo), { recursive: true });
    fs.writeFileSync(docsTodo, md, "utf-8");
    console.log(`📋 Updated todo.md (${pending.length} items in queue)`);
  } catch (err) {
    console.warn("Could not write todo.md:", err);
  }
}
