import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { fileURLToPath } from "url";
import { d1Client as client } from "./d1-client.js";
import { writeTodoMarkdown } from "./todo-helper.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface PendingGameRecord {
  i: string;
  t: string;
  s: string;
  u?: string | null;
  c?: string | null;
  dn?: string | null;
  gs?: string[];
  ts?: string[];
  dp?: number | null;
  votes: number;
  stars?: number | null;
  queuedAt: string;
  lastCheckedAt?: string | null;
}

interface EvaluationOptions {
  batchSize: number;
  delayMs: number;
  graduationMinVotes: number;
  dryRun: boolean;
}

interface EvaluationResult {
  evaluated: number;
  graduated: PendingGameRecord[];
  stillPending: number;
  errors: number;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Normalizes title string for aggressive deduplication:
 * Strips bracket metadata ([Free], [Windows]), punctuation, diacritics, and stop-words.
 */
function normalizeTitle(rawTitle: string): string {
  return decodeHtmlEntities(rawTitle || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/\[.*?\]/g, "") // strip all bracket tags like [Free], [Windows], [20% Off]
    .replace(/\(.*?\)/g, "") // strip parenthetical info
    .replace(/\b(demo|prologue|remake|remaster|free|download|game|reupload|edition)\b/gi, "")
    .replace(/[^a-z0-9]/g, "") // remove all non-alphanumeric chars
    .trim();
}

/**
 * Extracts Schema.org LD+JSON rating and tooltip rating without external dependencies
 */
function extractItchRating(html: string): { ratingScore: number | null; ratingCount: number; coverUrl: string | null } {
  let ratingScore: number | null = null;
  let ratingCount = 0;
  let coverUrl: string | null = null;

  // 1. JSON-LD extraction
  const scriptMatches = html.match(/<script type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/gi);
  if (scriptMatches) {
    for (const sm of scriptMatches) {
      const content = sm.replace(/<script[^>]*>|<\/script>/gi, "").trim();
      try {
        const obj = JSON.parse(content);
        const candidates = Array.isArray(obj) ? obj : [obj];
        for (const c of candidates) {
          if (c["@type"] === "Product" || c["@type"] === "VideoGame" || c.aggregateRating) {
            const agg = c.aggregateRating;
            if (agg) {
              if (agg.ratingValue !== undefined) {
                const v = parseFloat(agg.ratingValue);
                if (!isNaN(v)) ratingScore = Math.round((v / 5) * 100);
              }
              if (agg.ratingCount !== undefined) {
                const count = parseInt(String(agg.ratingCount).replace(/,/g, ""), 10);
                if (!isNaN(count)) ratingCount = count;
              }
            }
          }
        }
      } catch {}
    }
  }

  // 2. HTML Tooltip fallback
  if (ratingCount === 0) {
    const tooltipMatch = html.match(/data-tooltip=["']([\d.]+)\s+average rating from ([\d,]+) total ratings["']/i);
    if (tooltipMatch) {
      ratingScore = Math.round((parseFloat(tooltipMatch[1]) / 5) * 100);
      ratingCount = parseInt(tooltipMatch[2].replace(/,/g, ""), 10);
    }
  }

  // 3. Cover URL fallback from meta og:image
  const ogImageMatch = html.match(/<meta property=["']og:image["'] content=["']([^"']+)["']/i);
  if (ogImageMatch) {
    coverUrl = ogImageMatch[1];
  }

  return { ratingScore, ratingCount, coverUrl };
}

/**
 * Resolves canonical itch.io URL from record
 */
function resolveCandidateUrl(g: PendingGameRecord): string | null {
  if (g.u && g.u.startsWith("http")) return g.u;

  if (g.dn && g.s) {
    const authorSlug = g.dn.toLowerCase().replace(/[^a-z0-9]/g, "");
    let gameSlug = g.s.replace(/^itch-/, "");
    if (authorSlug && gameSlug.startsWith(`${authorSlug}-`)) {
      gameSlug = gameSlug.slice(authorSlug.length + 1);
    }
    if (authorSlug) {
      return `https://${authorSlug}.itch.io/${gameSlug}`;
    }
  }

  if (g.s) {
    const raw = g.s.replace(/^itch-/, "");
    const parts = raw.split("-");
    if (parts.length >= 2) {
      const author = parts[0];
      const gameSlug = parts.slice(1).join("-");
      return `https://${author}.itch.io/${gameSlug}`;
    }
  }

  return null;
}

export async function evaluatePendingPool(options: Partial<EvaluationOptions> = {}): Promise<EvaluationResult> {
  const config: EvaluationOptions = {
    batchSize: options.batchSize ?? 100,
    delayMs: options.delayMs ?? 800,
    graduationMinVotes: options.graduationMinVotes ?? 2,
    dryRun: options.dryRun ?? false,
  };

  console.log("===============================================================");
  console.log("⏳ HOGAMEGATA PENDING POOL ROLLING EVALUATION ENGINE");
  console.log("===============================================================");
  console.log(`Config: Batch Size=${config.batchSize} | Delay=${config.delayMs}ms | Min Votes=${config.graduationMinVotes} | Dry Run=${config.dryRun}\n`);

  let pendingPath = path.join(process.cwd(), "docs", "public", "pending-catalog.json.gz");
  if (!fs.existsSync(pendingPath)) {
    pendingPath = path.join(process.cwd(), "data", "pending-catalog.json.gz");
  }

  if (!fs.existsSync(pendingPath)) {
    console.log(`⚠️ pending-catalog.json.gz not found at: ${pendingPath}. Nothing to evaluate.`);
    return { evaluated: 0, graduated: [], stillPending: 0, errors: 0 };
  }

  const rawGzip = fs.readFileSync(pendingPath);
  const pool: PendingGameRecord[] = JSON.parse(zlib.gunzipSync(rawGzip).toString("utf-8"));
  console.log(`📦 Loaded ${pool.length.toLocaleString()} games currently in incubation.\n`);

  // Load Catalog Dump for Deduplication against Canonical & Active Itch Games
  let dumpPath = path.join(path.dirname(pendingPath), "catalog-dump.json.gz");
  if (!fs.existsSync(dumpPath)) {
    dumpPath = path.join(process.cwd(), "public", "catalog", "catalog-dump.json.gz");
  }
  if (!fs.existsSync(dumpPath)) {
    dumpPath = path.join(process.cwd(), "data", "curated-catalog-dump.json.gz");
  }

  const canonicalMainGameMap = new Map<string, any>();
  const existingItchGameMap = new Map<string, any>();

  if (fs.existsSync(dumpPath)) {
    try {
      const rawCatalogGzip = fs.readFileSync(dumpPath);
      const catalog = JSON.parse(zlib.gunzipSync(rawCatalogGzip).toString("utf-8"));
      for (const catGame of catalog) {
        const norm = normalizeTitle(catGame.t);
        if (norm) {
          if (catGame.s && !catGame.s.startsWith("itch-")) {
            if (!canonicalMainGameMap.has(norm)) canonicalMainGameMap.set(norm, catGame);
          } else {
            if (!existingItchGameMap.has(norm)) existingItchGameMap.set(norm, catGame);
          }
        }
      }
      console.log(
        `🧠 Catalog Deduplication Index Ready: ${canonicalMainGameMap.size.toLocaleString()} canonical games, ${existingItchGameMap.size.toLocaleString()} active itch games.\n`
      );
    } catch (e: any) {
      console.warn(`⚠️ Could not parse catalog-dump for deduplication: ${e?.message}`);
    }
  }

  // Sort by rolling priority window:
  // Never checked first, then oldest checked
  const sorted = pool
    .map((g, idx) => ({ g, idx }))
    .sort((a, b) => {
      if (!a.g.lastCheckedAt && b.g.lastCheckedAt) return -1;
      if (a.g.lastCheckedAt && !b.g.lastCheckedAt) return 1;
      if (!a.g.lastCheckedAt && !b.g.lastCheckedAt) return 0;
      return new Date(a.g.lastCheckedAt!).getTime() - new Date(b.g.lastCheckedAt!).getTime();
    });

  const candidates = sorted.slice(0, config.batchSize);
  console.log(`🎯 Evaluating ${candidates.length} games in current rolling window:\n`);

  const graduated: PendingGameRecord[] = [];
  const graduatedIndices = new Set<number>();
  let errorCount = 0;

  for (let i = 0; i < candidates.length; i++) {
    const { g, idx } = candidates[i];
    const candidateUrl = resolveCandidateUrl(g);

    console.log(`[${i + 1}/${candidates.length}] Inspecting: "${g.t}" (${g.s})`);
    if (!candidateUrl) {
      console.log(`    ⚠️ No valid URL resolvable. Marking checked.`);
      g.lastCheckedAt = new Date().toISOString();
      continue;
    }

    try {
      const res = await fetch(candidateUrl, {
        headers: {
          "User-Agent": "GamegataIncubationBot/1.0 (+https://gamegata.xyz)",
          Accept: "text/html,application/xhtml+xml",
        },
      });

      if (!res.ok) {
        console.log(`    ⚠️ HTTP status ${res.status}. Marking checked.`);
        g.lastCheckedAt = new Date().toISOString();
        errorCount++;
        await sleep(config.delayMs);
        continue;
      }

      const html = await res.text();
      const { ratingScore, ratingCount, coverUrl } = extractItchRating(html);
      console.log(`    📊 Status: Votes=${ratingCount} | Score=${ratingScore ?? "None"}%`);

      g.lastCheckedAt = new Date().toISOString();
      g.votes = ratingCount;
      if (ratingScore !== null) g.stars = ratingScore;
      if (coverUrl && !g.c) g.c = coverUrl;

      // Graduation Gate: has reached threshold
      if (ratingCount >= config.graduationMinVotes) {
        console.log(`    🎓 GRADUATED! Reached ${ratingCount} community votes. Promoting to Main Catalog!`);
        graduated.push(g);
        graduatedIndices.add(idx);
      } else {
        console.log(`    ⏳ Retained in incubation pool.`);
      }
    } catch (err: any) {
      console.warn(`    ⚠️ Fetch error: ${err?.message || err}`);
      g.lastCheckedAt = new Date().toISOString();
      errorCount++;
    }

    if (i < candidates.length - 1) {
      await sleep(config.delayMs);
    }
  }

  console.log("\n---------------------------------------------------------------");
  console.log("📊 RUN SUMMARY");
  console.log("---------------------------------------------------------------");
  console.log(`Evaluated in window:             ${candidates.length}`);
  console.log(`Graduated to Main Catalog:       ${graduated.length} 🎓`);
  console.log(`Retained in Incubation Pool:     ${pool.length - graduated.length}`);
  console.log(`Errors / Unreachable:            ${errorCount}\n`);

  if (config.dryRun) {
    console.log("🏃 Dry run mode: Skipping persistence.");
    return { evaluated: candidates.length, graduated, stillPending: pool.length - graduated.length, errors: errorCount };
  }

  // Persist updated incubation pool
  const updatedPool = pool.filter((_, idx) => !graduatedIndices.has(idx));
  const newGzip = zlib.gzipSync(Buffer.from(JSON.stringify(updatedPool), "utf-8"), { level: 9 });
  fs.writeFileSync(pendingPath, newGzip);
  console.log(`💾 Saved updated pending-catalog.json.gz (${(newGzip.length / (1024 * 1024)).toFixed(2)} MB, ${updatedPool.length.toLocaleString()} games remaining).`);

  // Update pending-manifest.json
  const manifestPath = path.join(path.dirname(pendingPath), "pending-manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      manifest.totalPending = updatedPool.length;
      manifest.lastEvaluatedAt = new Date().toISOString();
      manifest.sizeBytes = newGzip.length;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
    } catch {}
  }

  // If any games graduated, write to D1 and queue for Hugging Face catalog compilation
  if (graduated.length > 0) {
    console.log(`⚡ Promoting ${graduated.length} graduated games into Cloudflare D1 with Deduplication...`);
    const batchStatements: any[] = [];
    const now = Date.now();

    // Prepare pending-games queue
    const pendingGamesPath = path.join(path.dirname(pendingPath), "pending-games.json");
    let pendingGames: any[] = [];
    if (fs.existsSync(pendingGamesPath)) {
      try { pendingGames = JSON.parse(fs.readFileSync(pendingGamesPath, "utf-8")); } catch {}
    }
    const pendingIds = new Set(pendingGames.map((item: any) => item.id));

    let canonicalMatchesCount = 0;
    let itchMergedCount = 0;
    let newStandaloneCount = 0;

    for (const g of graduated) {
      const candidateUrl = resolveCandidateUrl(g) || `https://itch.io`;
      const author = g.dn || "Independent Creator";
      const tags = [...(g.gs || []), ...(g.ts || [])].join(", ") || "Horror, Indie";
      const dealPrice = g.dp ?? 0;
      const normTitle = normalizeTitle(g.t);

      // --- DEDUPLICATION TIER 1: CANONICAL MAIN GAME MATCH ---
      if (canonicalMainGameMap.has(normTitle)) {
        const canonical = canonicalMainGameMap.get(normTitle)!;
        console.log(
          `     🎯 MATCHED CANONICAL MAIN GAME: "${g.t}" matches existing game "${canonical.t}" (${canonical.s})! Attaching store link without duplicate entity.`
        );
        canonicalMatchesCount++;

        batchStatements.push({
          sql: `INSERT INTO "PurchaseLink" (id, storeName, url, gameId) VALUES (?, 'itch.io', ?, ?) ON CONFLICT DO NOTHING`,
          args: [`pl_${g.i}`, candidateUrl, canonical.i],
        });
        batchStatements.push({
          sql: `INSERT INTO "PriceSnapshot" (
            id, gameId, storeName, dealPrice, retailPrice, discountPercent, dealUrl, currency, country, provider, updatedAt
          ) VALUES (?, ?, 'itch.io', ?, ?, 0, ?, 'USD', 'US', 'direct', ?)
          ON CONFLICT DO NOTHING`,
          args: [`ps_${g.i}`, canonical.i, dealPrice, dealPrice, candidateUrl, now],
        });
        if (g.c) {
          batchStatements.push({
            sql: `UPDATE "Game" SET coverUrl = coalesce(coverUrl, ?) WHERE id = ?`,
            args: [g.c, canonical.i],
          });
        }
        if (!pendingIds.has(`link_${g.i}`)) {
          pendingGames.push({
            _type: "canonicalLink",
            id: `link_${g.i}`,
            targetGameId: canonical.i,
            url: candidateUrl,
            dealPrice,
            retailPrice: dealPrice,
            discountPercent: 0,
            coverUrl: g.c || null,
            queuedAt: new Date().toISOString(),
          });
          pendingIds.add(`link_${g.i}`);
        }
        continue;
      }

      // --- DEDUPLICATION TIER 2: EXISTING ACTIVE ITCH GAME MATCH ---
      if (existingItchGameMap.has(normTitle)) {
        const existingItch = existingItchGameMap.get(normTitle)!;
        console.log(
          `     ⏩ MERGED EXISTING ITCH LISTING: "${g.t}" matches active game "${existingItch.t}" (${existingItch.s}). Updating rating & store link without duplicate entity.`
        );
        itchMergedCount++;

        batchStatements.push({
          sql: `UPDATE "Game" SET rating = coalesce(?, rating), coverUrl = coalesce(coverUrl, ?), updatedAt = ? WHERE id = ?`,
          args: [g.stars ?? null, g.c || null, now, existingItch.i],
        });
        batchStatements.push({
          sql: `INSERT INTO "PurchaseLink" (id, storeName, url, gameId) VALUES (?, 'itch.io', ?, ?) ON CONFLICT DO NOTHING`,
          args: [`pl_${g.i}`, candidateUrl, existingItch.i],
        });
        continue;
      }

      // --- BRAND NEW VALIDATED STANDALONE HORROR GAME ---
      newStandaloneCount++;

      // 1. Game Table
      batchStatements.push({
        sql: `INSERT INTO "Game" (
          id, title, slug, coverUrl, developerNames, genreNames, platformNames, status, source, rating, isTrending, likesCount, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, 'PC', 'released', 'itch', ?, 0, 0, ?, ?)
        ON CONFLICT DO UPDATE SET rating = excluded.rating, coverUrl = coalesce("Game".coverUrl, excluded.coverUrl), updatedAt = excluded.updatedAt`,
        args: [g.i, g.t, g.s, g.c || null, author, tags, g.stars ?? null, now, now],
      });

      // 2. PurchaseLink Table
      batchStatements.push({
        sql: `INSERT INTO "PurchaseLink" (id, storeName, url, gameId) VALUES (?, 'itch.io', ?, ?) ON CONFLICT DO NOTHING`,
        args: [`pl_${g.i}`, candidateUrl, g.i],
      });

      // 3. PriceSnapshot Table
      batchStatements.push({
        sql: `INSERT INTO "PriceSnapshot" (
          id, gameId, storeName, dealPrice, retailPrice, discountPercent, dealUrl, currency, country, provider, updatedAt
        ) VALUES (?, ?, 'itch.io', ?, ?, 0, ?, 'USD', 'US', 'direct', ?)
        ON CONFLICT DO NOTHING`,
        args: [`ps_${g.i}`, g.i, dealPrice, dealPrice, candidateUrl, now],
      });

      if (!pendingIds.has(g.i)) {
        pendingGames.push({
          id: g.i,
          title: g.t,
          slug: g.s,
          coverUrl: g.c || null,
          author: g.dn || "Independent Creator",
          rating: g.stars ?? null,
          totalRating: g.stars ?? null,
          url: resolveCandidateUrl(g),
          tags: [...(g.gs || []), ...(g.ts || [])].join(", "),
          status: "released",
          source: "itch",
          dealPrice: g.dp ?? 0,
          retailPrice: g.dp ?? 0,
          discountPercent: 0,
          queuedAt: new Date().toISOString(),
          graduatedFromIncubation: true,
        });
        pendingIds.add(g.i);
      }
    }

    console.log(
      `📊 Graduation Deduplication Summary: ${newStandaloneCount} brand-new standalone games, ${canonicalMatchesCount} matched to canonical games, ${itchMergedCount} merged into active itch listings.`
    );

    try {
      if (batchStatements.length > 0) {
        await client.batch(batchStatements, "write");
        console.log(`💾 Successfully committed batch transaction (${batchStatements.length} operations) to Cloudflare D1!`);
      }
    } catch (e: any) {
      console.warn(`⚠️ D1 batch write failed: ${e?.message || e}. Games will queue in pending-games.json.`);
    }

    fs.writeFileSync(pendingGamesPath, JSON.stringify(pendingGames, null, 2), "utf-8");
    writeTodoMarkdown(pendingGames);
    console.log(`📝 Appended graduated games to pending-games.json. Ready for HF catalog compilation.`);
  }

  // Signal GitHub Actions output
  if (process.env.GITHUB_OUTPUT) {
    const hasGraduated = graduated.length > 0;
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `graduated_count=${graduated.length}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `rebuild_needed=${hasGraduated}\n`);
  }

  console.log("===============================================================");
  console.log("🏁 EVALUATION COMPLETED SUCCESSFULLY");
  console.log("===============================================================");

  return { evaluated: candidates.length, graduated, stillPending: updatedPool.length, errors: errorCount };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : 100;
  const minVotesArg = process.argv.find((a) => a.startsWith("--min-votes="));
  const minVotes = minVotesArg ? parseInt(minVotesArg.split("=")[1], 10) : 2;
  const isDryRun = process.argv.includes("--dry-run");

  evaluatePendingPool({ batchSize: limit, graduationMinVotes: minVotes, dryRun: isDryRun }).catch(console.error);
}
