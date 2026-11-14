import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { d1Client, escapeSqlValue, type Statement } from "./d1-client";

// Generic Configuration via Environment Secrets
const apiBase = (process.env.SYNC_API_BASE || "").trim().replace(/\/+$/, "");
const apiKey = (process.env.SYNC_API_KEY || "").trim().replace(/["'\s]/g, "");
const authHeader = (process.env.SYNC_AUTH_HEADER || "hoGAMEGATA-Automation/1.0").trim();
const targetTable = (
  process.env.SYNC_TABLE_NAME ||
  Buffer.from("UGxheVRyYWNrZXJJbnNpZ2h0", "base64").toString("utf8")
).trim();

if (!apiBase || !apiKey) {
  console.error("[DataSync] Error: Required environment variables (SYNC_API_BASE, SYNC_API_KEY) are missing.");
  process.exit(1);
}

// Configurable Limits & Rate-Limit Safeguards
const MIN_BATCH = 5;
const MAX_BATCH = 200;
const DEFAULT_BATCH = 50;

const MIN_DELAY_MS = 12000; // Safeguard: never exceed upstream rate-limits (<= 5 req/min)
const MAX_DELAY_MS = 60000;
const DEFAULT_DELAY_MS = 13000;

// CLI Parameter Parsing
const args = process.argv.slice(2);
const batchArg = args.find((a) => a.startsWith("--batch="));
const delayArg = args.find((a) => a.startsWith("--delay="));
const forceArg = args.includes("--force");
const dryRunArg = args.includes("--dry-run");

const requestedBatch = batchArg ? parseInt(batchArg.split("=")[1], 10) : DEFAULT_BATCH;
const BATCH_SIZE = Math.min(Math.max(isNaN(requestedBatch) ? DEFAULT_BATCH : requestedBatch, MIN_BATCH), MAX_BATCH);

const requestedDelay = delayArg ? parseInt(delayArg.split("=")[1], 10) : DEFAULT_DELAY_MS;
const RATE_DELAY_MS = Math.min(Math.max(isNaN(requestedDelay) ? DEFAULT_DELAY_MS : requestedDelay, MIN_DELAY_MS), MAX_DELAY_MS);

// Local cache for directory data
const cacheDir = path.resolve(".cache");
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}
const directoryCachePath = path.join(cacheDir, "upstream_directory.json");

async function getDirectoryIndex(): Promise<Record<string, any>> {
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  if (fs.existsSync(directoryCachePath)) {
    try {
      const stat = fs.statSync(directoryCachePath);
      const age = Date.now() - stat.mtimeMs;
      if (age < ONE_DAY_MS && stat.size > 1000) {
        console.log(`[DataSync] Using cached upstream directory index (${(age / 1000 / 3600).toFixed(1)}h old)`);
        return JSON.parse(fs.readFileSync(directoryCachePath, "utf-8"));
      }
    } catch {
      // Fall through to live download
    }
  }

  console.log("[DataSync] Downloading fresh directory index from upstream provider...");
  try {
    const res = await fetch(`${apiBase}/directory/?apikey=${apiKey}`, {
      headers: { "User-Agent": authHeader },
      signal: AbortSignal.timeout(30000),
    });

    if (res.ok) {
      const text = await res.text();
      fs.writeFileSync(directoryCachePath, text, "utf-8");
      console.log(`[DataSync] Fresh directory index cached. Size: ${(text.length / 1024 / 1024).toFixed(2)} MB`);
      return JSON.parse(text);
    }
    console.warn(`[DataSync] Directory fetch returned HTTP ${res.status}. Checking offline mapping fallback...`);
  } catch (err: any) {
    console.warn(`[DataSync] Directory fetch network issue: ${err.message}. Checking offline fallback...`);
  }

  // Offline fallback to external-id-map.json
  const fallbackPath = path.resolve(__dirname, "external-id-map.json");
  if (fs.existsSync(fallbackPath)) {
    console.log("[DataSync] Utilizing offline fallback index: external-id-map.json");
    const mapping = JSON.parse(fs.readFileSync(fallbackPath, "utf-8"));
    const syntheticDirectory: Record<string, any> = {};
    for (const [appId, extId] of Object.entries(mapping)) {
      syntheticDirectory[extId as string] = { platform: "steam", appID: appId };
    }
    return syntheticDirectory;
  }

  throw new Error("Unable to obtain upstream directory index (download failed and no fallback found)");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("==================================================");
  console.log(`⚡ Community Playtime Stats Sync Engine`);
  console.log(`   Batch: ${BATCH_SIZE} (min: ${MIN_BATCH}, max: ${MAX_BATCH})`);
  console.log(`   Pacing: ${RATE_DELAY_MS}ms (safeguard floor: ${MIN_DELAY_MS}ms)`);
  console.log("==================================================");

  const directory = await getDirectoryIndex();

  // Build secondary ID map (e.g. Steam AppID -> Upstream Provider ID)
  const idMap = new Map<string, string>();
  for (const [extId, entry] of Object.entries(directory)) {
    if (entry.platform === "steam" && entry.appID) {
      idMap.set(String(entry.appID).trim(), extId);
    }
  }
  console.log(`[DataSync] Indexed ${idMap.size.toLocaleString()} upstream title mappings.`);

  // Query catalog candidates needing enrichment
  const STALE_THRESHOLD_MS = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const filterClause = forceArg ? "" : `AND (pti.id IS NULL OR pti.lastSync < ${STALE_THRESHOLD_MS})`;

  const candidateQuery = `
    SELECT g.id, g.title, g.slug, g.steamAppId, g.playtime, pti.lastSync
    FROM Game g
    LEFT JOIN ${targetTable} pti ON pti.gameId = g.id
    WHERE g.steamAppId IS NOT NULL AND g.steamAppId != ''
    ${filterClause}
    ORDER BY g.popularity DESC, g.likesCount DESC
    LIMIT ${Math.max(BATCH_SIZE * 5, 200)}
  `;

  console.log(`[DataSync] Fetching priority candidates from database...`);
  const candidateResult = await d1Client.execute(candidateQuery);
  const candidateRows = candidateResult.rows || [];
  console.log(`[DataSync] Retrieved ${candidateRows.length} catalog candidates.`);

  // Filter candidates that exist in the upstream provider index
  const queue: Array<{ id: string; title: string; slug: string; steamAppId: string; playtime: number | null; extId: string }> = [];
  for (const row of candidateRows) {
    const appId = String(row.steamAppId).trim();
    if (idMap.has(appId)) {
      queue.push({
        ...row,
        extId: idMap.get(appId)!,
      });
      if (queue.length >= BATCH_SIZE) break;
    }
  }

  console.log(`[DataSync] Ingestion queue prepared: ${queue.length} items to enrich.`);
  if (queue.length === 0) {
    console.log("[DataSync] All catalog metrics are currently up to date! Exiting cleanly.");
    return;
  }

  const statements: Statement[] = [];
  let processed = 0;
  let successCount = 0;

  for (const item of queue) {
    processed++;
    console.log(`\n[${processed}/${queue.length}] Syncing: "${item.title}" (Steam: ${item.steamAppId} -> ExtID: ${item.extId})`);

    if (dryRunArg) {
      console.log("  [Dry Run] Fetch skipped.");
      continue;
    }

    try {
      const url = `${apiBase}/game/?game=${item.extId}&apikey=${apiKey}`;
      const res = await fetch(url, {
        headers: { "User-Agent": authHeader },
        signal: AbortSignal.timeout(15000),
      });

      if (res.status === 429) {
        console.warn("  [Upstream 429 Rate Limit] Backing off 30 seconds...");
        await sleep(30000);
        continue;
      }

      if (!res.ok) {
        console.warn(`  Fetch returned status ${res.status}. Skipping.`);
        await sleep(RATE_DELAY_MS);
        continue;
      }

      const json = await res.json();
      if (!json || !json.success || !json.data) {
        console.warn("  Response payload missing or unsuccessful. Skipping.");
        await sleep(RATE_DELAY_MS);
        continue;
      }

      const d = json.data;

      // Extract affinity / related items
      const relatedGames: Array<{ ptId: string; name: string; platform: string; appId: string | null; affinity: number }> = [];
      if (d.related) {
        for (const [rPtId, affinity] of Object.entries(d.related)) {
          const entry = directory[rPtId];
          relatedGames.push({
            ptId: rPtId,
            name: entry?.name || "Unknown",
            platform: entry?.platform || "steam",
            appId: entry?.appID || null,
            affinity: Number(affinity) || 0,
          });
        }
        relatedGames.sort((a, b) => b.affinity - a.affinity);
      }

      const personasJson = d.personas ? JSON.stringify(d.personas) : null;
      const relatedJson = JSON.stringify(relatedGames);
      const distJson = d.charts?.playtime_distribution_percents ? JSON.stringify(d.charts.playtime_distribution_percents) : null;
      const geoJson = d.geography ? JSON.stringify(d.geography) : null;
      const now = Date.now();

      const insertSql = `
        INSERT OR REPLACE INTO ${targetTable} (
          id, gameId, steamAppId, ownerEstimate, activeEstimate, marginOfError,
          averageMinutesPlayed, medianMinutesPlayed, averageAchievements,
          personas, relatedGames, playtimeDistribution, geography, lastSync
        ) VALUES (
          ${escapeSqlValue(item.extId)},
          ${escapeSqlValue(item.id)},
          ${escapeSqlValue(item.steamAppId)},
          ${escapeSqlValue(d.owner_estimate || null)},
          ${escapeSqlValue(d.active_estimate || null)},
          ${escapeSqlValue(d.margin_of_error || null)},
          ${escapeSqlValue(d.engagement?.average_minutes_played || null)},
          ${escapeSqlValue(d.engagement?.median_minutes_played || null)},
          ${escapeSqlValue(d.engagement?.average_achievements || null)},
          ${escapeSqlValue(personasJson)},
          ${escapeSqlValue(relatedJson)},
          ${escapeSqlValue(distJson)},
          ${escapeSqlValue(geoJson)},
          ${now}
        );
      `;
      statements.push(insertSql);

      // Backfill Game.playtime if missing
      if ((!item.playtime || item.playtime <= 0) && d.engagement?.median_minutes_played) {
        const hours = Math.round(d.engagement.median_minutes_played / 60);
        if (hours > 0) {
          const updatePlaytimeSql = `UPDATE Game SET playtime = ${hours} WHERE id = ${escapeSqlValue(item.id)};`;
          statements.push(updatePlaytimeSql);
          console.log(`  Updated Game.playtime -> ${hours} hrs`);
        }
      }

      console.log(`  Updated! Owners: ${d.owner_estimate?.toLocaleString() || "N/A"}, Median: ${d.engagement?.median_minutes_played || 0}m, Affinity: ${relatedGames.length}`);
      successCount++;
    } catch (err: any) {
      console.error(`  Error enriching metric record: ${err.message}`);
    }

    if (processed < queue.length) {
      console.log(`  Pacing: Waiting ${RATE_DELAY_MS / 1000}s to respect rate-limit boundary...`);
      await sleep(RATE_DELAY_MS);
    }
  }

  // Commit batch statements to Cloudflare D1
  if (statements.length > 0) {
    console.log(`\n[DataSync] Committing ${statements.length} metric updates to D1...`);
    try {
      await d1Client.batch(statements, "write", 25);
      console.log(`[DataSync] Successfully committed ${statements.length} updates.`);
    } catch (err: any) {
      console.error(`[DataSync] Error committing batch to database: ${err.message}`);
      throw err;
    }
  }

  console.log("\n==================================================");
  console.log(`🎉 Pipeline Complete: ${successCount} / ${queue.length} items successfully updated.`);
  console.log("==================================================");
}

main().catch((err) => {
  console.error("[DataSync] Fatal error:", err);
  process.exit(1);
});
