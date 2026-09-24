import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import * as crypto from "crypto";
import { d1Client as client } from "./d1-client.js";
import { writeTodoMarkdown } from "./todo-helper.js";

interface CatalogRecord {
  i: string;
  t: string;
  s: string;
  c?: string | null;
  dn?: string | null;
  d?: string[] | string | null;
  pn?: string | null;
  rd?: number | null;
  rt?: number | null;
  sr?: number | null;
  mc?: number | null;
  rr?: number | null;
  cat?: number | null;
  pop?: number | null;
  tr?: boolean;
  lk?: number;
  gs?: string[];
  ts?: string[];
  dp?: number | null;
  st?: string | null;
}

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

interface FeedItem {
  title: string;
  link: string;
}

// Strict Horror Pattern Gate
const HORROR_TAG_REGEX =
  /horror|creepy|scary|spooky|survival-horror|psychological-horror|analog-horror|slasher|paranormal|haunted|gore|dread|lovecraft|monster|nightmare|zombie|demon/i;

// Curated Horror Feeds (Popular, Top-Rated, Top-Sellers, Subgenres, and Kalrog >5 ratings)
const FEEDS = [
  "https://itch.io/games/tag-horror.xml",
  "https://itch.io/games/top-rated/tag-horror.xml",
  "https://itch.io/games/top-sellers/tag-horror.xml",
  "https://itch.io/games/tag-psychological-horror.xml",
  "https://itch.io/games/tag-survival-horror.xml",
  "https://better-itch-search.kalrog.com/games/feed.xml?aq=tag:horror+ratings:>5&sort=date",
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

async function fetchItchPageHtml(url: string, timeoutMs = 5000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "GamegataHorrorBot/1.0 (+https://gamegata.xyz)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return null;
    return await response.text();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Dependency-free extraction of Schema.org LD+JSON rating, tooltip rating, and cover
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
          if (c.image && typeof c.image === "string" && !coverUrl) {
            coverUrl = c.image;
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
  if (!coverUrl) {
    const ogImageMatch = html.match(/<meta property=["']og:image["'] content=["']([^"']+)["']/i);
    if (ogImageMatch) {
      coverUrl = ogImageMatch[1];
    }
  }

  return { ratingScore, ratingCount, coverUrl };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const isDryRun = process.argv.includes("--dry-run");
  console.log(`🎃 [Itch Horror Ingestion] Starting discovery & deduplication pipeline (Dry run: ${isDryRun})...`);

  // Path resolution for either gamegata-astro or project-hgg.github.io
  let dumpPath = path.join(process.cwd(), "docs", "public", "catalog-dump.json.gz");
  if (!fs.existsSync(dumpPath)) {
    dumpPath = path.join(process.cwd(), "public", "catalog", "catalog-dump.json.gz");
  }
  if (!fs.existsSync(dumpPath)) {
    dumpPath = path.join(process.cwd(), "..", "project-hgg.github.io", "docs", "public", "catalog-dump.json.gz");
  }
  if (!fs.existsSync(dumpPath)) {
    console.error(`❌ catalog-dump.json.gz not found at: ${dumpPath}`);
    process.exit(1);
  }

  // 1. Two-Tiered In-Memory Deduplication Index: Active Catalog + Incubation Pool
  console.log("📂 Loading catalog dump to build deduplication index...");
  const rawGzip = fs.readFileSync(dumpPath);
  const catalog: CatalogRecord[] = JSON.parse(zlib.gunzipSync(rawGzip).toString("utf-8"));
  console.log(`📦 Loaded ${catalog.length.toLocaleString()} existing games from catalog-dump.json.gz.`);

  const existingIds = new Set<string>();
  const existingSlugs = new Set<string>();
  const existingUrlHashes = new Set<string>();

  // Canonical IGDB/Steam game map (normTitle -> record)
  const canonicalMainGameMap = new Map<string, CatalogRecord>();
  // Existing Itch game map (normTitle -> record)
  const existingItchGameMap = new Map<string, CatalogRecord>();

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

  // 1b. Load Incubation Pool (pending-catalog.json.gz)
  let pendingPoolPath = path.join(path.dirname(dumpPath), "pending-catalog.json.gz");
  if (!fs.existsSync(pendingPoolPath)) {
    pendingPoolPath = path.join(process.cwd(), "data", "pending-catalog.json.gz");
  }
  let pendingPool: PendingGameRecord[] = [];
  const existingPendingIds = new Set<string>();
  const existingPendingSlugs = new Set<string>();
  const existingPendingUrls = new Set<string>();

  if (fs.existsSync(pendingPoolPath)) {
    try {
      const rawPendingGzip = fs.readFileSync(pendingPoolPath);
      pendingPool = JSON.parse(zlib.gunzipSync(rawPendingGzip).toString("utf-8"));
      for (const p of pendingPool) {
        if (p.i) existingPendingIds.add(p.i);
        if (p.s) existingPendingSlugs.add(p.s.toLowerCase());
        if (p.u) existingPendingUrls.add(normalizeItchUrl(p.u));
      }
      console.log(`📦 Loaded ${pendingPool.length.toLocaleString()} games from pending incubation pool.`);
    } catch (e: any) {
      console.warn(`⚠️ Could not parse pending-catalog.json.gz: ${e?.message}`);
    }
  }

  console.log(
    `🧠 Deduplication Index Ready: ${canonicalMainGameMap.size} canonical main games, ${existingItchGameMap.size} active itch games, ${existingPendingIds.size} pending incubation games.`
  );

  // 2. Poll Curated Horror RSS Feeds
  const discoveredMap = new Map<string, string>(); // canonicalUrl -> feedTitle

  for (const feedUrl of FEEDS) {
    try {
      console.log(`📡 Polling curated feed: ${feedUrl}...`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(feedUrl, {
        headers: { "User-Agent": "GamegataHorrorBot/1.0 (+https://gamegata.xyz)" },
        signal: controller.signal,
      });
      clearTimeout(timer);

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
    } catch (err: any) {
      console.warn(`⚠️ Failed to fetch feed ${feedUrl} (${err?.message || err}), continuing...`);
    }
  }

  console.log(`🔍 Total unique game URLs discovered: ${discoveredMap.size}`);

  // 3. Pre-Filter against active catalog & incubation pool
  const candidates: { url: string; feedTitle: string; urlHash: string }[] = [];

  for (const [url, feedTitle] of discoveredMap.entries()) {
    const urlHash = hashUrl(url);
    const expectedId = `itch_${urlHash}`;

    // Deduplication check: Already in active catalog
    if (existingIds.has(expectedId) || existingUrlHashes.has(urlHash)) {
      continue;
    }

    // Deduplication check: Already in pending incubation pool
    if (existingPendingIds.has(expectedId) || existingPendingUrls.has(url)) {
      continue;
    }

    // Deduplication check: Title normalized already matches an itch game in active catalog
    const preNorm = normalizeTitle(feedTitle);
    if (preNorm && existingItchGameMap.has(preNorm)) {
      continue;
    }

    candidates.push({ url, feedTitle, urlHash });
  }

  console.log(`🎯 New candidate horror games to inspect: ${candidates.length}`);

  if (candidates.length === 0) {
    console.log("✨ All discovered horror games are already tracked. Nothing to do.");
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `valid_new_count=0\nincubated_count=0\nrebuild_needed=false\n`);
    }
    return;
  }

  // 4. Inspection, Quality Evaluation Gate & Forking
  const validNewGames: any[] = [];
  const matchedCanonicalLinks: any[] = [];
  const pendingPoolToAppend: PendingGameRecord[] = [];

  const seenUrls = new Set<string>();
  const seenNormTitles = new Set<string>();
  const seenSlugs = new Set<string>();

  for (const candidate of candidates) {
    if (seenUrls.has(candidate.url)) continue;
    seenUrls.add(candidate.url);

    console.log(`  🔎 Inspecting: "${candidate.feedTitle}" (${candidate.url})...`);
    await delay(600); // Polite rate limit

    // Parallel fetch: data.json metadata + game page HTML
    const [data, pageHtml] = await Promise.all([
      fetchItchDataJson(candidate.url),
      fetchItchPageHtml(candidate.url),
    ]);

    if (!data && !pageHtml) {
      console.log(`     ⚠️ Unreachable (no data.json or HTML), skipping.`);
      continue;
    }

    // Horror-Only Gate: Verify tags or title contain horror semantics
    const tags: string[] = Array.isArray(data?.tags) ? data.tags : [];
    const isHorrorTagged = tags.some((t) => HORROR_TAG_REGEX.test(t));
    const titleIsHorror = HORROR_TAG_REGEX.test(data?.title || candidate.feedTitle);

    if (!isHorrorTagged && !titleIsHorror) {
      console.log(`     🚫 Rejected: Not confirmed horror (Tags: ${tags.join(", ")})`);
      continue;
    }

    const rawTitle = data?.title || candidate.feedTitle;
    const cleanTitle = cleanDisplayTitle(rawTitle);
    const normTitle = normalizeTitle(cleanTitle);

    // In-flight run deduplication
    if (seenNormTitles.has(normTitle)) {
      console.log(`     🔄 In-flight duplicate: "${cleanTitle}" already processed in this run.`);
      continue;
    }
    seenNormTitles.add(normTitle);

    // Secondary catalog check
    if (existingItchGameMap.has(normTitle)) {
      console.log(
        `     ⏩ Duplicate Itch Game: "${cleanTitle}" already in catalog as ${existingItchGameMap.get(normTitle)?.s}. Skipping.`
      );
      continue;
    }

    const author = data?.authors?.[0]?.name || "Independent Creator";

    // Extract Rating & Cover from HTML
    const { ratingScore, ratingCount, coverUrl: htmlCoverUrl } = pageHtml
      ? extractItchRating(pageHtml)
      : { ratingScore: null, ratingCount: 0, coverUrl: null };
    const coverUrl = data?.cover_image || htmlCoverUrl || null;

    // Parse Prices & Sales accurately
    let dealPrice = 0;
    if (typeof data?.price === "string") {
      const p = parseFloat(data.price.replace(/[^0-9.]/g, ""));
      if (!isNaN(p)) dealPrice = p;
    } else if (typeof data?.price === "number") {
      dealPrice = data.price;
    }

    let retailPrice = dealPrice;
    if (typeof data?.original_price === "string") {
      const p = parseFloat(data.original_price.replace(/[^0-9.]/g, ""));
      if (!isNaN(p)) retailPrice = p;
    } else if (typeof data?.original_price === "number") {
      retailPrice = data.original_price;
    }

    const discountPercent =
      data?.sale?.rate ||
      (retailPrice > dealPrice ? Math.round(((retailPrice - dealPrice) / retailPrice) * 100) : 0);

    // --- DEDUPLICATION TIER 3: CANONICAL MAIN GAME MATCH ---
    // If this itch game already exists as an IGDB/Steam game (e.g. Buckshot Roulette),
    // attach the itch purchase link and price snapshot to the canonical game instead of creating a duplicate!
    if (canonicalMainGameMap.has(normTitle)) {
      const canonical = canonicalMainGameMap.get(normTitle)!;
      console.log(
        `     🎯 MATCHED CANONICAL MAIN GAME: "${cleanTitle}" matches existing game "${canonical.t}" (${canonical.s})! Attaching itch store link without duplicating game entity.`
      );
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

    // Slug generation
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

    // --- QUALITY EVALUATION GATE ---
    // Community Traction Threshold: Must have >= 2 ratings to enter Active Catalog.
    // 0-rating and single-vote scrap are safely routed to Incubation Pool (pending-catalog.json.gz).
    if (ratingCount >= 2) {
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
        rating: ratingScore,
        votes: ratingCount,
      });
      console.log(
        `     ✅ Validated New Active Horror Game (Votes: ${ratingCount}, Score: ${ratingScore ?? "N/A"}%): "${cleanTitle}" by ${author} [Price: $${dealPrice}]`
      );
    } else {
      pendingPoolToAppend.push({
        i: gameId,
        t: cleanTitle,
        s: finalSlug,
        u: candidate.url,
        c: coverUrl,
        dn: author,
        gs: ["horror"],
        ts: tags.length > 0 ? tags : ["indie", "itch-io"],
        dp: dealPrice,
        votes: ratingCount,
        stars: ratingScore,
        queuedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
      });
      existingPendingIds.add(gameId);
      existingPendingUrls.add(candidate.url);
      console.log(
        `     ⏳ Incubation Pool: "${cleanTitle}" by ${author} (Votes: ${ratingCount}) routed to pending-catalog.json.gz.`
      );
    }
  }

  console.log(
    `\n🎉 Summary: ${validNewGames.length} active games validated, ${pendingPoolToAppend.length} games routed to incubation pool, ${matchedCanonicalLinks.length} matched to existing canonical games.`
  );

  // Set GitHub Actions workflow outputs
  if (process.env.GITHUB_OUTPUT) {
    const hasActiveUpdates = validNewGames.length > 0;
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `valid_new_count=${validNewGames.length}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `incubated_count=${pendingPoolToAppend.length}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `rebuild_needed=${hasActiveUpdates}\n`);
  }

  // 5. Persist Incubation Pool Updates (if any new games were added to incubation)
  if (pendingPoolToAppend.length > 0 && !isDryRun) {
    console.log(`📦 Updating pending incubation pool (+${pendingPoolToAppend.length} games)...`);
    pendingPool.push(...pendingPoolToAppend);
    const newPendingGzip = zlib.gzipSync(Buffer.from(JSON.stringify(pendingPool), "utf-8"), { level: 9 });
    fs.writeFileSync(pendingPoolPath, newPendingGzip);

    const pendingManifestPath = path.join(path.dirname(pendingPoolPath), "pending-manifest.json");
    const pManifest = {
      version: "1.0.0",
      totalPending: pendingPool.length,
      lastUpdated: new Date().toISOString(),
      compressedBytes: newPendingGzip.length,
      compressedMb: parseFloat((newPendingGzip.length / (1024 * 1024)).toFixed(2)),
    };
    fs.writeFileSync(pendingManifestPath, JSON.stringify(pManifest, null, 2), "utf-8");
    console.log(
      `💾 Saved updated pending-catalog.json.gz (${pManifest.compressedMb} MB, ${pendingPool.length.toLocaleString()} games total).`
    );

    // Sync to peer repo if available
    const otherPendingPath = pendingPoolPath.includes("project-hgg")
      ? path.join("c:", "Users", "bapum", "Desktop", "Portfolio", "gamegata-astro", "data", "pending-catalog.json.gz")
      : path.join("c:", "Users", "bapum", "Desktop", "Portfolio", "project-hgg.github.io", "docs", "public", "pending-catalog.json.gz");
    if (fs.existsSync(path.dirname(otherPendingPath))) {
      try {
        fs.copyFileSync(pendingPoolPath, otherPendingPath);
        const otherManifest = path.join(path.dirname(otherPendingPath), "pending-manifest.json");
        fs.writeFileSync(otherManifest, JSON.stringify(pManifest, null, 2), "utf-8");
      } catch {}
    }
  }

  if (validNewGames.length === 0 && matchedCanonicalLinks.length === 0) {
    console.log("✨ No new active games or canonical price links to commit to database.");
    return;
  }

  if (isDryRun) {
    console.log("🏃 Dry run mode: skipping database writes and active catalog updates.");
    return;
  }

  // 6. Batched Write Transaction into Cloudflare D1
  console.log("⚡ Executing batched write transaction into Cloudflare D1...");
  const batchStatements: any[] = [];
  const now = Date.now();

  // A. Insert Brand New Validated Games
  for (const g of validNewGames) {
    // 1. Game Table
    batchStatements.push({
      sql: `INSERT INTO "Game" (
        id, title, slug, coverUrl, developerNames, genreNames, platformNames, status, source, rating, isTrending, likesCount, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, 'PC', 'released', 'itch', ?, 0, 0, ?, ?)
      ON CONFLICT DO UPDATE SET rating = coalesce(excluded.rating, "Game".rating), coverUrl = coalesce("Game".coverUrl, excluded.coverUrl), updatedAt = excluded.updatedAt`,
      args: [g.id, g.title, g.slug, g.coverUrl, g.author, g.tags, g.rating ?? null, now, now],
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

  // 7. Save new validated games to pending-games.json for rich HF catalog compilation
  const pendingPath = path.join(process.cwd(), "docs", "public", "pending-games.json");
  let pending: any[] = [];
  if (fs.existsSync(pendingPath)) {
    try {
      pending = JSON.parse(fs.readFileSync(pendingPath, "utf-8"));
    } catch {}
  }
  const pendingIds = new Set(pending.map((g: any) => g.id));
  for (const g of validNewGames) {
    if (!pendingIds.has(g.id)) {
      pending.push({ ...g, queuedAt: new Date().toISOString() });
      pendingIds.add(g.id);
    }
  }
  for (const m of matchedCanonicalLinks) {
    const pendingLinkId = `link_${m.urlHash}`;
    if (!pendingIds.has(pendingLinkId)) {
      pending.push({ _type: "canonicalLink", id: pendingLinkId, ...m, queuedAt: new Date().toISOString() });
      pendingIds.add(pendingLinkId);
    }
  }
  fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2), "utf-8");

  // 8. Best-effort Batched Write Transaction into D1
  let d1Failed = false;
  let d1FailureReason = "";
  try {
    await client.batch(batchStatements, "write");
    console.log(`💾 Successfully committed batch transaction (${batchStatements.length} operations) to Cloudflare D1!`);
    const newIds = new Set([
      ...validNewGames.map((g) => g.id),
      ...matchedCanonicalLinks.map((m) => `link_${m.urlHash}`),
    ]);
    pending = pending.map((item) => (newIds.has(item.id) ? { ...item, inD1: true } : item));
  } catch (dbErr: any) {
    d1Failed = true;
    d1FailureReason = String(dbErr?.message || dbErr);
    console.warn(`⚠️ D1 write skipped/failed (quota or API limit): ${d1FailureReason}`);
    console.log(`📋 Games remain queued in pending-games.json for retry.`);
    const newIds = new Set([
      ...validNewGames.map((g) => g.id),
      ...matchedCanonicalLinks.map((m) => `link_${m.urlHash}`),
    ]);
    pending = pending.map((item) =>
      newIds.has(item.id) ? { ...item, inD1: false, failureReason: d1FailureReason } : item
    );
  }
  fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2), "utf-8");
  writeTodoMarkdown(pending);

  // 9. Append validated brand new games to catalog-dump.json.gz
  if (validNewGames.length > 0) {
    console.log("📝 Updating catalog-dump.json.gz with validated new games...");
    for (const g of validNewGames) {
      catalog.push({
        i: g.id,
        t: g.title,
        s: g.slug,
        c: g.coverUrl,
        dn: g.author,
        pn: "PC (Microsoft Windows)",
        rd: Math.floor(Date.now() / 1000),
        rt: g.rating ?? null,
        sr: null,
        mc: null,
        rr: null,
        cat: 0,
        pop: 1,
        tr: false,
        lk: 0,
        gs: ["horror"],
        ts: ["indie", "itch-io"],
        dp: g.dealPrice ?? 0,
        st: "released",
      });
    }

    const rawBuffer = Buffer.from(JSON.stringify(catalog));
    const gzipBuffer = zlib.gzipSync(rawBuffer, { level: 9 });
    fs.writeFileSync(dumpPath, gzipBuffer);

    // Update catalog-manifest.json
    const manifestPath = path.join(path.dirname(dumpPath), "catalog-manifest.json");
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        manifest.totalGames = catalog.length;
        manifest.compressedBytes = gzipBuffer.length;
        manifest.uncompressedBytes = rawBuffer.length;
        manifest.compressedMb = parseFloat((gzipBuffer.length / (1024 * 1024)).toFixed(2));
        manifest.uncompressedMb = parseFloat((rawBuffer.length / (1024 * 1024)).toFixed(2));
        manifest.updatedAt = new Date().toISOString();
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
      } catch {}
    }

    console.log(
      `✅ catalog-dump.json.gz updated. New total: ${catalog.length.toLocaleString()} games.${d1Failed ? " (D1 writes queued for retry)" : ""}`
    );

    // Synchronize across local repositories if available
    const otherDumpPath = dumpPath.includes("project-hgg")
      ? path.join("c:", "Users", "bapum", "Desktop", "Portfolio", "gamegata-astro", "public", "catalog", "catalog-dump.json.gz")
      : path.join("c:", "Users", "bapum", "Desktop", "Portfolio", "project-hgg.github.io", "docs", "public", "catalog-dump.json.gz");

    if (fs.existsSync(path.dirname(otherDumpPath))) {
      try {
        fs.copyFileSync(dumpPath, otherDumpPath);
        const manifestPath2 = path.join(path.dirname(dumpPath), "catalog-manifest.json");
        const otherManifestPath = path.join(path.dirname(otherDumpPath), "catalog-manifest.json");
        if (fs.existsSync(manifestPath2)) {
          fs.copyFileSync(manifestPath2, otherManifestPath);
        }
        console.log(`✅ Synced updated dump & manifest to peer repository!`);
      } catch {}
    }
  }

  if (d1Failed) {
    console.warn(`⚠️ Run completed with D1 failure. New games queued in pending-games.json for retry.`);
  } else {
    console.log("🏁 Ingestion & quality gate pipeline completed successfully!");
  }
}

main().catch((err) => {
  console.error("Fatal ingestion error:", err);
  process.exit(1);
});
