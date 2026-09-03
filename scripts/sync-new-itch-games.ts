import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { createClient } from "@libsql/client";

interface SearchRecord {
  i: string;
  t: string;
  s: string;
  c?: string | null;
  d?: string[] | string | null;
}

interface FeedItem {
  title: string;
  link: string;
}

// Strict Horror Pattern Gate
const HORROR_TAG_REGEX = /horror|creepy|scary|spooky|survival-horror|psychological-horror|analog-horror|slasher|paranormal|haunted|gore|dread|lovecraft|monster|nightmare|zombie|demon/i;

const FEEDS = [
  "https://better-itch-search.kalrog.com/games/feed.xml?aq=tag:horror&sort=date",
  "https://itch.io/games/newest/tag-horror.xml",
];

function hashUrl(url: string): string {
  return crypto.createHash("md5").update(url.toLowerCase().trim()).digest("hex").slice(0, 16);
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
 * Normalizes an itch.io URL to a canonical format to prevent URL-variant duplicates
 */
function normalizeItchUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl.trim());
    u.protocol = "https:";
    u.search = "";
    u.hash = "";
    const cleanPath = u.pathname.replace(/\/purchase$/, "").replace(/\/+$/, "");
    return `https://${u.hostname.toLowerCase()}${cleanPath}`;
  } catch {
    return rawUrl.trim().toLowerCase().split("?")[0].replace(/\/purchase$/, "").replace(/\/+$/, "");
  }
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
 * Cleans user-facing title by stripping bracket tags like [Free] [Windows]
 */
function cleanDisplayTitle(title: string): string {
  return decodeHtmlEntities(title || "")
    .replace(/\[.*?\]/g, "") // strip all brackets
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

function parseXmlFeed(xmlText: string): FeedItem[] {
  const items: FeedItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xmlText)) !== null) {
    const block = match[1];
    const titleMatch = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const linkMatch = block.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i);

    if (titleMatch && linkMatch) {
      const rawTitle = titleMatch[1].trim();
      const rawLink = linkMatch[1].trim();
      if (rawLink.includes(".itch.io/")) {
        const canonicalUrl = normalizeItchUrl(rawLink);
        items.push({ title: cleanDisplayTitle(rawTitle), link: canonicalUrl });
      }
    }
  }

  return items;
}

async function fetchItchDataJson(url: string, timeoutMs = 4000): Promise<any> {
  const canonicalUrl = normalizeItchUrl(url);
  const jsonUrl = canonicalUrl.endsWith("/data.json") ? canonicalUrl : `${canonicalUrl}/data.json`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(jsonUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        Referer: "https://itch.io/",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return null;
    return await response.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const isDryRun = process.argv.includes("--dry-run");
  console.log(`🎃 [Itch Horror Ingestion] Starting discovery & deduplication pipeline (Dry run: ${isDryRun})...`);

  // Path resolution for either gamegata-astro or project-hgg.github.io
  let indexPath = path.join(process.cwd(), "docs", "public", "search-index.json");
  if (!fs.existsSync(indexPath)) {
    indexPath = path.join(process.cwd(), "public", "search-index.json");
  }
  if (!fs.existsSync(indexPath)) {
    console.error(`❌ search-index.json not found at: ${indexPath}`);
    process.exit(1);
  }

  // 1. Two-Tiered In-Memory Deduplication Index: 0 Turso reads!
  console.log("📂 Loading catalog to build deduplication index...");
  const catalog: SearchRecord[] = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  console.log(`📦 Loaded ${catalog.length} existing games from search-index.json.`);

  const existingIds = new Set<string>();
  const existingSlugs = new Set<string>();
  const existingUrlHashes = new Set<string>();

  // Canonical IGDB/Steam game map (normTitle -> record)
  const canonicalMainGameMap = new Map<string, SearchRecord>();
  // Existing Itch game map (normTitle -> record)
  const existingItchGameMap = new Map<string, SearchRecord>();

  for (const g of catalog) {
    if (g.i) existingIds.add(g.i);
    if (g.s) existingSlugs.add(g.s.toLowerCase());

    if (g.i && g.i.startsWith("itch_")) {
      const uHash = g.i.replace(/^itch_/, "");
      existingUrlHashes.add(uHash);
    }

    const norm = normalizeTitle(g.t);
    if (norm) {
      if (g.s && !g.s.startsWith("itch-")) {
        if (!canonicalMainGameMap.has(norm)) {
          canonicalMainGameMap.set(norm, g);
        }
      } else {
        if (!existingItchGameMap.has(norm)) {
          existingItchGameMap.set(norm, g);
        }
      }
    }
  }

  console.log(`🧠 Deduplication Index Ready: ${canonicalMainGameMap.size} canonical main games, ${existingItchGameMap.size} existing itch games.`);

  // 2. Poll Horror RSS Feeds
  const discoveredMap = new Map<string, string>(); // canonicalUrl -> feedTitle

  for (const feedUrl of FEEDS) {
    try {
      console.log(`📡 Polling horror feed: ${feedUrl}...`);
      const res = await fetch(feedUrl, {
        headers: { "User-Agent": "GamegataHorrorBot/1.0 (+https://gamegata.xyz)" },
      });
      if (!res.ok) {
        console.warn(`⚠️ Feed returned status ${res.status}: ${feedUrl}`);
        continue;
      }
      const xml = await res.text();
      const items = parseXmlFeed(xml);
      console.log(`   Found ${items.length} items in feed.`);

      for (const item of items) {
        const canonicalUrl = normalizeItchUrl(item.link);
        if (!discoveredMap.has(canonicalUrl)) {
          discoveredMap.set(canonicalUrl, item.title);
        }
      }
    } catch (err) {
      console.warn(`⚠️ Failed to fetch feed ${feedUrl}:`, err);
    }
  }

  console.log(`🔍 Total unique game URLs discovered: ${discoveredMap.size}`);

  // 3. Pre-Filter against existing catalog
  const candidates: { url: string; feedTitle: string; urlHash: string }[] = [];

  for (const [url, feedTitle] of discoveredMap.entries()) {
    const urlHash = hashUrl(url);
    const expectedId = `itch_${urlHash}`;

    // Deduplication check: Exact ID or URL hash already exists
    if (existingIds.has(expectedId) || existingUrlHashes.has(urlHash)) {
      continue;
    }

    // Deduplication check: Title normalized already matches an itch game
    const preNorm = normalizeTitle(feedTitle);
    if (preNorm && existingItchGameMap.has(preNorm)) {
      continue;
    }

    candidates.push({ url, feedTitle, urlHash });
  }

  console.log(`🎯 New candidate horror games to inspect: ${candidates.length}`);

  if (candidates.length === 0) {
    console.log("✨ All discovered horror games are already in the catalog. Nothing to do.");
    return;
  }

  // 4. Selective data.json Enrichment & Multi-Tier Deduplication
  const validNewGames: any[] = [];
  const matchedCanonicalLinks: any[] = [];

  // In-flight run deduplication sets to prevent duplicate items within the same feed
  const seenUrls = new Set<string>();
  const seenNormTitles = new Set<string>();
  const seenSlugs = new Set<string>();

  for (const candidate of candidates) {
    if (seenUrls.has(candidate.url)) continue;
    seenUrls.add(candidate.url);

    console.log(`  🔎 Enriching: ${candidate.feedTitle} (${candidate.url})...`);
    await delay(700); // Polite rate limit

    const data = await fetchItchDataJson(candidate.url);
    if (!data) {
      console.log(`     ⚠️ No data.json response, skipping.`);
      continue;
    }

    // Horror-Only Gate: Verify tags or title contain horror semantics
    const tags: string[] = Array.isArray(data.tags) ? data.tags : [];
    const isHorrorTagged = tags.some((t) => HORROR_TAG_REGEX.test(t));
    const titleIsHorror = HORROR_TAG_REGEX.test(data.title || candidate.feedTitle);

    if (!isHorrorTagged && !titleIsHorror) {
      console.log(`     🚫 Rejected: Not confirmed horror (Tags: ${tags.join(", ")})`);
      continue;
    }

    const rawTitle = data.title || candidate.feedTitle;
    const cleanTitle = cleanDisplayTitle(rawTitle);
    const normTitle = normalizeTitle(cleanTitle);

    // In-flight batch deduplication
    if (seenNormTitles.has(normTitle)) {
      console.log(`     🔄 In-flight duplicate: "${cleanTitle}" already processed in this run.`);
      continue;
    }
    seenNormTitles.add(normTitle);

    // Secondary catalog check: Did data.title reveal it's already in the itch catalog?
    if (existingItchGameMap.has(normTitle)) {
      console.log(`     ⏩ Duplicate Itch Game: "${cleanTitle}" already exists in catalog as ${existingItchGameMap.get(normTitle)?.s}. Skipping.`);
      continue;
    }

    const author = data.authors?.[0]?.name || "Independent Creator";
    const coverUrl = data.cover_image || null;

    // Parse Prices & Sales accurately
    let dealPrice = 0;
    if (typeof data.price === "string") {
      const p = parseFloat(data.price.replace(/[^0-9.]/g, ""));
      if (!isNaN(p)) dealPrice = p;
    } else if (typeof data.price === "number") {
      dealPrice = data.price;
    }

    let retailPrice = dealPrice;
    if (typeof data.original_price === "string") {
      const p = parseFloat(data.original_price.replace(/[^0-9.]/g, ""));
      if (!isNaN(p)) retailPrice = p;
    } else if (typeof data.original_price === "number") {
      retailPrice = data.original_price;
    }

    const discountPercent =
      data.sale?.rate ||
      (retailPrice > dealPrice ? Math.round(((retailPrice - dealPrice) / retailPrice) * 100) : 0);

    // --- DEDUPLICATION TIER 3: CANONICAL MAIN GAME MATCH ---
    // If this itch game already exists as an IGDB/Steam game (e.g. Buckshot Roulette),
    // attach the itch purchase link and price snapshot to the canonical game instead of creating a duplicate!
    if (canonicalMainGameMap.has(normTitle)) {
      const canonical = canonicalMainGameMap.get(normTitle)!;
      console.log(`     🎯 MATCHED CANONICAL MAIN GAME: "${cleanTitle}" matches existing game "${canonical.t}" (${canonical.s})! Attaching itch store link without duplicating game entity.`);
      matchedCanonicalLinks.push({
        targetGameId: canonical.i,
        url: candidate.url,
        urlHash: candidate.urlHash,
        dealPrice,
        retailPrice,
        discountPercent,
        coverUrl,
      });
      continue;
    }

    // --- NEW INDIE HORROR GAME INGESTION ---
    let baseSlug = slugify(cleanTitle);
    if (!baseSlug) baseSlug = `game-${candidate.urlHash}`;
    let finalSlug = `itch-${baseSlug}`;

    if (existingSlugs.has(finalSlug) || seenSlugs.has(finalSlug)) {
      finalSlug = `itch-${slugify(author)}-${baseSlug}`;
      if (existingSlugs.has(finalSlug) || seenSlugs.has(finalSlug)) {
        finalSlug = `itch-${baseSlug}-${candidate.urlHash.slice(0, 6)}`;
      }
    }
    existingSlugs.add(finalSlug);
    seenSlugs.add(finalSlug);

    const gameId = `itch_${candidate.urlHash}`;

    validNewGames.push({
      id: gameId,
      title: cleanTitle,
      slug: finalSlug,
      coverUrl,
      author,
      dealPrice,
      retailPrice,
      discountPercent,
      url: candidate.url,
      tags: tags.join(", ") || "Horror, Indie",
    });

    console.log(`     ✅ Validated New Horror Game: "${cleanTitle}" by ${author} [Price: $${dealPrice}]`);
  }

  console.log(`\n🎉 Summary: ${validNewGames.length} brand new games, ${matchedCanonicalLinks.length} matched to existing canonical games.`);

  if (validNewGames.length === 0 && matchedCanonicalLinks.length === 0) {
    console.log("✨ No new games or price links to insert.");
    return;
  }

  if (isDryRun) {
    console.log("🏃 Dry run mode: skipping database writes and file updates.");
    return;
  }

  // 5. Single Batched Write Transaction into TursoDB
  const dbUrl = process.env.TURSO_DATABASE_URL;
  const dbToken = process.env.TURSO_AUTH_TOKEN;

  if (!dbUrl) {
    console.error("❌ Missing TURSO_DATABASE_URL environment variable.");
    process.exit(1);
  }

  console.log("⚡ Executing single batched write transaction into TursoDB...");
  const client = createClient({ url: dbUrl, authToken: dbToken });
  const batchStatements: any[] = [];
  const now = Date.now();

  // A. Insert Brand New Games
  for (const g of validNewGames) {
    // 1. Game Table
    batchStatements.push({
      sql: `INSERT INTO "Game" (
        id, title, slug, coverUrl, developerNames, genreNames, platformNames, status, source, isTrending, likesCount, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, 'PC', 'released', 'itch', 0, 0, ?, ?)
      ON CONFLICT DO NOTHING`,
      args: [g.id, g.title, g.slug, g.coverUrl, g.author, g.tags, now, now],
    });

    // 2. PurchaseLink Table
    batchStatements.push({
      sql: `INSERT INTO "PurchaseLink" (id, storeName, url, gameId) VALUES (?, 'itch.io', ?, ?) ON CONFLICT DO NOTHING`,
      args: [`pl_${g.id}`, g.url, g.id],
    });

    // 3. PriceSnapshot Table
    batchStatements.push({
      sql: `INSERT INTO "PriceSnapshot" (
        id, gameId, storeName, dealPrice, retailPrice, discountPercent, dealUrl, currency, country, provider, updatedAt
      ) VALUES (?, ?, 'itch.io', ?, ?, ?, ?, 'USD', 'US', 'direct', ?)
      ON CONFLICT DO NOTHING`,
      args: [`ps_${g.id}`, g.id, g.dealPrice, g.retailPrice, g.discountPercent, g.url, now],
    });
  }

  // B. Attach Itch Links & Price Snapshots to Existing Canonical Games
  for (const m of matchedCanonicalLinks) {
    batchStatements.push({
      sql: `INSERT INTO "PurchaseLink" (id, storeName, url, gameId) VALUES (?, 'itch.io', ?, ?) ON CONFLICT DO NOTHING`,
      args: [`pl_itch_${m.urlHash}`, m.url, m.targetGameId],
    });

    batchStatements.push({
      sql: `INSERT INTO "PriceSnapshot" (
        id, gameId, storeName, dealPrice, retailPrice, discountPercent, dealUrl, currency, country, provider, updatedAt
      ) VALUES (?, ?, 'itch.io', ?, ?, ?, ?, 'USD', 'US', 'direct', ?)
      ON CONFLICT DO NOTHING`,
      args: [`ps_itch_${m.urlHash}`, m.targetGameId, m.dealPrice, m.retailPrice, m.discountPercent, m.url, now],
    });

    // Backfill coverUrl if canonical game was missing one
    if (m.coverUrl) {
      batchStatements.push({
        sql: `UPDATE "Game" SET coverUrl = coalesce(coverUrl, ?) WHERE id = ?`,
        args: [m.coverUrl, m.targetGameId],
      });
    }
  }

  try {
    await client.batch(batchStatements, "write");
    console.log(`💾 Successfully committed batch transaction (${batchStatements.length} operations) to TursoDB!`);
  } catch (dbErr) {
    console.error("❌ Turso batch insert error:", dbErr);
    process.exit(1);
  }

  // 6. Append Brand New Games to search-index.json
  if (validNewGames.length > 0) {
    console.log("📝 Updating search-index.json with deduplicated entries...");
    for (const g of validNewGames) {
      catalog.push({
        i: g.id,
        t: g.title,
        s: g.slug,
        c: g.coverUrl,
        d: [g.author],
      });
    }

    fs.writeFileSync(indexPath, JSON.stringify(catalog), "utf-8");
    console.log(`✅ search-index.json updated. New total games: ${catalog.length}.`);

    // Synchronize across local repositories if available
    const otherPath = indexPath.includes("project-hgg")
      ? path.join("c:", "Users", "bapum", "Desktop", "Portfolio", "gamegata-astro", "public", "search-index.json")
      : path.join("c:", "Users", "bapum", "Desktop", "Portfolio", "project-hgg.github.io", "docs", "public", "search-index.json");

    if (fs.existsSync(path.dirname(otherPath))) {
      try {
        fs.copyFileSync(indexPath, otherPath);
        console.log(`✅ Synced updated index to peer repository!`);
      } catch {}
    }
  }

  console.log("🏁 Ingestion & deduplication pipeline completed successfully!");
}

main().catch((err) => {
  console.error("Fatal ingestion error:", err);
  process.exit(1);
});
