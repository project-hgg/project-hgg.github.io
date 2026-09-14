/**
 * retry-pending-games.ts
 *
 * Reads docs/public/pending-games.json (games that failed to write to D1 due
 * to quota/API errors) and retries inserting them. On success, removes them
 * from the queue. Also updates the HF catalog if any new entries were added.
 *
 * Run automatically by .github/workflows/retry-pending.yml every 6 hours.
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { d1Client as client } from "./d1-client.js";
import { writeTodoMarkdown } from "./todo-helper.js";

const PENDING_PATH = path.join(process.cwd(), "docs", "public", "pending-games.json");

interface PendingGame {
  _type?: string;
  id: string;
  title?: string;
  slug?: string;
  coverUrl?: string | null;
  author?: string;
  dealPrice?: number;
  retailPrice?: number;
  discountPercent?: number;
  url?: string;
  tags?: string;
  queuedAt: string;
  failureReason?: string;
  // canonical link fields
  targetGameId?: string;
  urlHash?: string;
}

async function main() {
  if (!fs.existsSync(PENDING_PATH)) {
    console.log("✅ No pending-games.json found — nothing to retry.");
    return;
  }

  let pending: PendingGame[] = [];
  try {
    pending = JSON.parse(fs.readFileSync(PENDING_PATH, "utf-8"));
  } catch {
    console.error("❌ Could not parse pending-games.json. Aborting.");
    process.exit(1);
  }

  if (pending.length === 0) {
    console.log("✅ pending-games.json is empty — nothing to retry.");
    fs.writeFileSync(PENDING_PATH, "[]", "utf-8");
    writeTodoMarkdown([]);
    return;
  }

  // Filter only items that haven't yet been successfully written to D1
  const unwrittenToD1 = pending.filter((e) => !e.inD1);
  if (unwrittenToD1.length === 0) {
    console.log("✅ All items in queue are already written to D1. Checking if any await HF sync...");
    const offsetsPath = path.join(process.cwd(), "docs", "public", "offsets.json.gz");
    const offsetsSet = new Set<string>();
    if (fs.existsSync(offsetsPath)) {
      try {
        const rawOffsets = zlib.gunzipSync(fs.readFileSync(offsetsPath)).toString("utf-8");
        const parsed = JSON.parse(rawOffsets);
        if (Array.isArray(parsed)) {
          for (const item of parsed) if (item.s) offsetsSet.add(item.s);
        } else if (parsed && typeof parsed === "object") {
          for (const key of Object.keys(parsed)) offsetsSet.add(key);
        }
      } catch {}
    }

    const checkHfStatus = (item: any) =>
      Boolean(
        item.inHf ||
        item._type === "canonicalLink" ||
        (item.slug && offsetsSet.has(item.slug)) ||
        (item.id && offsetsSet.has(item.id))
      );

    const remainingForHf = pending
      .map((e: any) => ({ ...e, inHf: checkHfStatus(e) }))
      .filter((e) => !(e.inD1 && e.inHf));

    fs.writeFileSync(PENDING_PATH, JSON.stringify(remainingForHf, null, 2), "utf-8");
    writeTodoMarkdown(remainingForHf);
    return;
  }

  console.log(`📋 Found ${unwrittenToD1.length} pending entries to retry in D1 (total in queue: ${pending.length})...`);

  const newGameEntries = unwrittenToD1.filter((e) => e._type !== "canonicalLink");
  const canonicalLinks = unwrittenToD1.filter((e) => e._type === "canonicalLink");

  const batchStatements: any[] = [];
  const now = Date.now();

  // Rebuild batch for new games
  for (const g of newGameEntries) {
    batchStatements.push({
      sql: `INSERT INTO "Game" (
        id, title, slug, coverUrl, developerNames, genreNames, platformNames, status, source, isTrending, likesCount, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, 'PC', 'released', 'itch', 0, 0, ?, ?)
      ON CONFLICT DO NOTHING`,
      args: [g.id, g.title, g.slug, g.coverUrl ?? null, g.author ?? null, g.tags ?? "Horror, Indie", now, now],
    });

    batchStatements.push({
      sql: `INSERT INTO "PurchaseLink" (id, storeName, url, gameId) VALUES (?, 'itch.io', ?, ?) ON CONFLICT DO NOTHING`,
      args: [`pl_${g.id}`, g.url, g.id],
    });

    batchStatements.push({
      sql: `INSERT INTO "PriceSnapshot" (
        id, gameId, storeName, dealPrice, retailPrice, discountPercent, dealUrl, currency, country, provider, updatedAt
      ) VALUES (?, ?, 'itch.io', ?, ?, ?, ?, 'USD', 'US', 'direct', ?)
      ON CONFLICT DO NOTHING`,
      args: [`ps_${g.id}`, g.id, g.dealPrice ?? 0, g.retailPrice ?? 0, g.discountPercent ?? 0, g.url, now],
    });
  }

  // Rebuild batch for canonical links
  for (const m of canonicalLinks) {
    if (!m.urlHash || !m.targetGameId) continue;
    batchStatements.push({
      sql: `INSERT INTO "PurchaseLink" (id, storeName, url, gameId) VALUES (?, 'itch.io', ?, ?) ON CONFLICT DO NOTHING`,
      args: [`pl_itch_${m.urlHash}`, m.url, m.targetGameId],
    });

    batchStatements.push({
      sql: `INSERT INTO "PriceSnapshot" (
        id, gameId, storeName, dealPrice, retailPrice, discountPercent, dealUrl, currency, country, provider, updatedAt
      ) VALUES (?, ?, 'itch.io', ?, ?, ?, ?, 'USD', 'US', 'direct', ?)
      ON CONFLICT DO NOTHING`,
      args: [`ps_itch_${m.urlHash}`, m.targetGameId, m.dealPrice ?? 0, m.retailPrice ?? 0, m.discountPercent ?? 0, m.url, now],
    });
  }

    // Helper to check which items already exist in the HF dataset via offsets.json.gz
    const offsetsPath = path.join(process.cwd(), "docs", "public", "offsets.json.gz");
    const offsetsSet = new Set<string>();
    if (fs.existsSync(offsetsPath)) {
      try {
        const rawOffsets = zlib.gunzipSync(fs.readFileSync(offsetsPath)).toString("utf-8");
        const parsed = JSON.parse(rawOffsets);
        if (Array.isArray(parsed)) {
          for (const item of parsed) if (item.s) offsetsSet.add(item.s);
        } else if (parsed && typeof parsed === "object") {
          for (const key of Object.keys(parsed)) offsetsSet.add(key);
        }
      } catch {}
    }

    const checkHfStatus = (item: any) =>
      Boolean(
        item.inHf ||
        item._type === "canonicalLink" ||
        (item.slug && offsetsSet.has(item.slug)) ||
        (item.id && offsetsSet.has(item.id))
      );

    const remainingForHf = pending
      .map((e: any) => ({ ...e, inHf: checkHfStatus(e) }))
      .filter((e) => !(e.inD1 && e.inHf));

    fs.writeFileSync(PENDING_PATH, JSON.stringify(remainingForHf, null, 2), "utf-8");
    writeTodoMarkdown(remainingForHf);
    return;
  }

  try {
    await client.batch(batchStatements, "write");
    console.log(`💾 Successfully retried ${batchStatements.length} D1 operations for ${unwrittenToD1.length} pending entries!`);

    // Helper to check which items already exist in the HF dataset via offsets.json.gz
    const offsetsPath = path.join(process.cwd(), "docs", "public", "offsets.json.gz");
    const offsetsSet = new Set<string>();
    if (fs.existsSync(offsetsPath)) {
      try {
        const rawOffsets = zlib.gunzipSync(fs.readFileSync(offsetsPath)).toString("utf-8");
        const parsed = JSON.parse(rawOffsets);
        if (Array.isArray(parsed)) {
          for (const item of parsed) if (item.s) offsetsSet.add(item.s);
        } else if (parsed && typeof parsed === "object") {
          for (const key of Object.keys(parsed)) offsetsSet.add(key);
        }
      } catch {}
    }

    const checkHfStatus = (item: any) =>
      Boolean(
        item.inHf ||
        item._type === "canonicalLink" ||
        (item.slug && offsetsSet.has(item.slug)) ||
        (item.id && offsetsSet.has(item.id))
      );

    // Mark successful items as inD1 = true and evaluate inHf
    const updated = pending.map((e: any) => ({
      ...e,
      inD1: true,
      inHf: checkHfStatus(e),
      failureReason: undefined,
    }));

    // If an item is already merged in HF and now in D1, it can be dropped from queue
    const remaining = updated.filter((e) => !(e.inD1 && e.inHf));
    fs.writeFileSync(PENDING_PATH, JSON.stringify(remaining, null, 2), "utf-8");
    writeTodoMarkdown(remaining);
    console.log(`✅ Queue updated: ${remaining.length} items remaining awaiting HF sync.`);

    // Also update data-version.json metadata
    const dvPath = path.join(process.cwd(), "docs", "public", "data-version.json");
    if (fs.existsSync(dvPath)) {
      try {
        const dv = JSON.parse(fs.readFileSync(dvPath, "utf-8"));
        dv.lastRetryAt = new Date().toISOString();
        dv.retriedCount = (dv.retriedCount || 0) + unwrittenToD1.length;
        fs.writeFileSync(dvPath, JSON.stringify(dv, null, 2), "utf-8");
        console.log("📝 Updated data-version.json with retry metadata.");
      } catch {}
    }
  } catch (err: any) {
    const msg = String(err?.message || err);
    console.warn(`⚠️  D1 retry failed again: ${msg}`);
    console.log(`📋 ${pending.length} entries remain in queue for the next attempt.`);

    // Update the failureReason in pending queue with latest error
    const updated = pending.map((e) => ({ ...e, lastRetryAt: new Date().toISOString(), failureReason: msg }));
    fs.writeFileSync(PENDING_PATH, JSON.stringify(updated, null, 2), "utf-8");
    writeTodoMarkdown(updated);
    // Exit 0 so the workflow doesn't fail (will retry next scheduled run)
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal retry error:", err);
  process.exit(1);
});
