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

function cleanFeedTitle(title: string): string {
  return decodeHtmlEntities(title)
    .replace(/\[(?:Free|Demo|Windows|macOS|Linux|Android|iOS|WebGL|HTML5|Shooter|Action|Adventure|Puzzle|Simulation|Survival|Visual Novel|Role Playing|Platformer|Other)\]/gi, "")
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
        const cleanUrl = rawLink.replace(/\/purchase$/, "").replace(/\/+$/, "");
        items.push({ title: cleanFeedTitle(rawTitle), link: cleanUrl });
      }
    }
  }

  return items;
}

async function fetchItchDataJson(url: string, timeoutMs = 4000): Promise<any> {
  const cleanUrl = url.trim().replace(/\/purchase$/, "").replace(/\/+$/, "");
  const jsonUrl = cleanUrl.endsWith("/data.json") ? cleanUrl : `${cleanUrl}/data.json`;

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
  console.log(`🎃 [Itch Horror Ingestion] Starting discovery pipeline (Dry run: ${isDryRun})...`);

  // Path inside project-hgg.github.io
  const indexPath = path.join(process.cwd(), "docs", "public", "search-index.json");
  if (!fs.existsSync(indexPath)) {
    console.error(`❌ search-index.json not found at: ${indexPath}`);
    process.exit(1);
  }

  // 1. In-memory diff: 0 Turso reads!
  console.log("📂 Loading search index to diff...");
  const catalog: SearchRecord[] = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  console.log(`📦 Loaded ${catalog.length} existing games from search-index.json.`);

  const existingSlugs = new Set<string>();
  const existingTitles = new Set<string>();
  const existingIds = new Set<string>();

  for (const g of catalog) {
    if (g.s) existingSlugs.add(g.s.toLowerCase());
    if (g.t) existingTitles.add(g.t.toLowerCase().trim());
    if (g.i) existingIds.add(g.i);
  }

  // 2. Poll Horror RSS Feeds
  const discoveredMap = new Map<string, string>(); // url -> title

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
        if (!discoveredMap.has(item.link)) {
          discoveredMap.set(item.link, item.title);
        }
      }
    } catch (err) {
      console.warn(`⚠️ Failed to fetch feed ${feedUrl}:`, err);
    }
  }

  console.log(`🔍 Total unique game URLs discovered: ${discoveredMap.size}`);

  // 3. Diff against existing catalog
  const candidates: { url: string; feedTitle: string; urlHash: string }[] = [];

  for (const [url, feedTitle] of discoveredMap.entries()) {
    const urlHash = hashUrl(url);
    const expectedId = `itch_${urlHash}`;

    if (existingIds.has(expectedId)) continue;
    if (existingTitles.has(feedTitle.toLowerCase().trim())) continue;

    candidates.push({ url, feedTitle, urlHash });
  }

  console.log(`🎯 New candidate horror games to inspect: ${candidates.length}`);

  if (candidates.length === 0) {
    console.log("✨ All discovered horror games are already in the catalog. Nothing to do.");
    return;
  }

  // 4. Selective data.json Enrichment & Horror Gate Verification
  const validNewGames: any[] = [];

  for (const candidate of candidates) {
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

    const title = decodeHtmlEntities((data.title || candidate.feedTitle).trim());
    const author = data.authors?.[0]?.name || "Independent Creator";
    const coverUrl = data.cover_image || null;

    let baseSlug = slugify(title);
    if (!baseSlug) baseSlug = `game-${candidate.urlHash}`;
    let finalSlug = `itch-${baseSlug}`;
    if (existingSlugs.has(finalSlug)) {
      finalSlug = `itch-${slugify(author)}-${baseSlug}`;
      if (existingSlugs.has(finalSlug)) {
        finalSlug = `itch-${baseSlug}-${candidate.urlHash.slice(0, 6)}`;
      }
    }
    existingSlugs.add(finalSlug);

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

    const gameId = `itch_${candidate.urlHash}`;

    validNewGames.push({
      id: gameId,
      title,
      slug: finalSlug,
      coverUrl,
      author,
      dealPrice,
      retailPrice,
      discountPercent,
      url: candidate.url,
      tags: tags.join(", ") || "Horror, Indie",
    });

    console.log(`     ✅ Validated Horror: "${title}" by ${author} [Price: $${dealPrice}]`);
  }

  console.log(`\n🎉 Verified ${validNewGames.length} new horror games ready to ingest.`);

  if (validNewGames.length === 0) {
    console.log("✨ No new games passed horror validation.");
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

  try {
    await client.batch(batchStatements, "write");
    console.log(`💾 Successfully inserted ${validNewGames.length} new horror games into TursoDB!`);
  } catch (dbErr) {
    console.error("❌ Turso batch insert error:", dbErr);
    process.exit(1);
  }

  // 6. Append to docs/public/search-index.json
  console.log("📝 Updating docs/public/search-index.json...");
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

  // 7. Also mirror to gamegata-astro if local folder exists
  const gamegataPath = path.join("c:", "Users", "bapum", "Desktop", "Portfolio", "gamegata-astro", "public", "search-index.json");
  if (fs.existsSync(path.dirname(gamegataPath))) {
    try {
      fs.copyFileSync(indexPath, gamegataPath);
      console.log(`✅ Synced updated index to gamegata-astro!`);
    } catch {}
  }

  console.log("🏁 Ingestion pipeline completed successfully!");
}

main().catch((err) => {
  console.error("Fatal ingestion error:", err);
  process.exit(1);
});
