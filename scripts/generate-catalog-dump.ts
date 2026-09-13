import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { d1Client as client } from "./d1-client.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface EntityRef {
  name: string;
  slug: string;
}

interface PurchaseLinkRecord {
  storeName: string;
  url: string;
}

interface PriceSnapshotRecord {
  storeName: string;
  dealPrice: number | null;
  retailPrice: number | null;
  discountPercent: number | null;
  dealUrl: string | null;
  currency: string | null;
  country: string | null;
  provider: string | null;
}

/** Compact search-index entry embedded in catalog-dump.json.gz */
interface CatalogRecord {
  i: string;         // id
  t: string;         // title
  s: string;         // slug
  c: string | null;  // coverUrl
  dn: string | null; // developerNames (denormalized)
  pn: string | null; // platformNames  (denormalized)
  rd: number | null; // releaseDate epoch seconds
  rt: number | null; // rating 0-100
  sr: number | null; // steamRating (0-100 scaled)
  mc: number | null; // metacritic
  rr: number | null; // rawgRating
  cat: number | null;// category
  pop: number | null;// popularity
  tr: boolean;       // isTrending
  lk: number;        // likesCount
  gs: string[];      // genre slugs
  ts: string[];      // tag slugs
  dp: number | null; // cheapest deal price
  st: string | null; // status
  /** byte offset in catalog.raw (injected after raw is written) */
  o?: number;
  /** byte length in catalog.raw (injected after raw is written) */
  l?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const GAME_BATCH = 5_000; // Stay safely under D1 1 MB response cap

async function loadEntityMap(tableName: string): Promise<Map<string, EntityRef>> {
  const map = new Map<string, EntityRef>();
  // D1 has no row limit here since entity tables are small (<500 rows each)
  try {
    const res = await client.execute(`SELECT id, name, slug FROM "${tableName}"`);
    for (const r of res.rows) {
      if (r.id && r.name && r.slug) {
        map.set(String(r.id), { name: String(r.name), slug: String(r.slug) });
      }
    }
    console.log(`   ✓ ${tableName}: ${map.size.toLocaleString()} entries`);
  } catch (err: any) {
    console.warn(`   ⚠️ Could not load ${tableName}: ${err.message}`);
  }
  return map;
}

async function loadJoinMap(
  joinTable: string,
  entityCol: "A" | "B",
  gameCol: "A" | "B",
  entityLookup: Map<string, EntityRef>
): Promise<Map<string, EntityRef[]>> {
  const map = new Map<string, EntityRef[]>();
  try {
    const res = await client.execute(`SELECT "A", "B" FROM "${joinTable}"`);
    for (const r of res.rows) {
      const entityId = String(r[entityCol]);
      const gameId = String(r[gameCol]);
      const ref = entityLookup.get(entityId);
      if (ref) {
        if (!map.has(gameId)) map.set(gameId, []);
        map.get(gameId)!.push(ref);
      }
    }
    console.log(`   ✓ ${joinTable}: ${res.rows.length.toLocaleString()} associations → ${map.size.toLocaleString()} games`);
  } catch (err: any) {
    console.warn(`   ⚠️ Could not load ${joinTable}: ${err.message}`);
  }
  return map;
}

function safeJson<T>(val: any): T | null {
  if (val == null) return null;
  if (typeof val === "string") {
    try { return JSON.parse(val) as T; } catch { return null; }
  }
  return val as T;
}

function toEpochSec(val: any): number | null {
  if (val == null) return null;
  const n = Number(val);
  if (isNaN(n) || n <= 0) return null;
  return n > 100_000_000_000 ? Math.floor(n / 1000) : n;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function generateCatalogDump() {
  const t0 = performance.now();
  console.log("===========================================================");
  console.log("📦  PROJECT-HGG: GENERATING FULL CATALOG DUMP + HF MASTER");
  console.log("===========================================================\n");

  // Output directories
  const hfDir = path.resolve("dist-hf");
  const docsDir = path.resolve("docs", "public");
  for (const dir of [hfDir, docsDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  const rawFilePath = path.join(hfDir, "catalog.raw");

  // ── 1. Entity lookup maps ─────────────────────────────────────────────────
  console.log("1. Loading entity lookup maps...");
  const [devsMap, genresMap, platformsMap, tagsMap, pubsMap] = await Promise.all([
    loadEntityMap("Developer"),
    loadEntityMap("Genre"),
    loadEntityMap("Platform"),
    loadEntityMap("Tag"),
    loadEntityMap("Publisher"),
  ]);

  // ── 2. Join maps ──────────────────────────────────────────────────────────
  console.log("\n2. Loading relation join maps...");
  const [gameDevs, gameGenres, gamePlatforms, gameTags, gamePubs] = await Promise.all([
    loadJoinMap("_DeveloperToGame", "A", "B", devsMap),
    loadJoinMap("_GameToGenre",     "B", "A", genresMap),
    loadJoinMap("_GameToPlatform",  "B", "A", platformsMap),
    loadJoinMap("_GameToTag",       "B", "A", tagsMap),
    loadJoinMap("_GameToPublisher", "B", "A", pubsMap),
  ]);

  // ── 3. Price maps ─────────────────────────────────────────────────────────
  console.log("\n3. Loading purchase links & deal prices...");
  const purchaseLinksMap = new Map<string, PurchaseLinkRecord[]>();
  const priceSnapshotsMap = new Map<string, PriceSnapshotRecord[]>();
  const priceMinMap = new Map<string, number>(); // cheapest deal price

  try {
    const pLinksRes = await client.execute(
      `SELECT gameId, storeName, url FROM "PurchaseLink"`
    );
    for (const r of pLinksRes.rows) {
      const gId = String(r.gameId);
      if (!purchaseLinksMap.has(gId)) purchaseLinksMap.set(gId, []);
      purchaseLinksMap.get(gId)!.push({
        storeName: String(r.storeName || ""),
        url: String(r.url || ""),
      });
    }
    console.log(`   ✓ PurchaseLink: ${pLinksRes.rows.length.toLocaleString()} rows`);
  } catch (err: any) {
    console.warn(`   ⚠️ PurchaseLink: ${err.message}`);
  }

  try {
    const pSnapRes = await client.execute(
      `SELECT gameId, storeName, dealPrice, retailPrice, discountPercent, dealUrl, currency, country, provider FROM "PriceSnapshot"`
    );
    for (const r of pSnapRes.rows) {
      const gId = String(r.gameId);
      const deal = r.dealPrice != null ? Number(r.dealPrice) : null;
      // Track minimum
      if (deal != null) {
        const cur = priceMinMap.get(gId);
        if (cur == null || deal < cur) priceMinMap.set(gId, deal);
      }
      if (!priceSnapshotsMap.has(gId)) priceSnapshotsMap.set(gId, []);
      priceSnapshotsMap.get(gId)!.push({
        storeName: String(r.storeName || ""),
        dealPrice: deal,
        retailPrice: r.retailPrice != null ? Number(r.retailPrice) : null,
        discountPercent: r.discountPercent != null ? Number(r.discountPercent) : null,
        dealUrl: r.dealUrl != null ? String(r.dealUrl) : null,
        currency: r.currency != null ? String(r.currency) : null,
        country: r.country != null ? String(r.country) : null,
        provider: r.provider != null ? String(r.provider) : null,
      });
    }
    console.log(`   ✓ PriceSnapshot: ${pSnapRes.rows.length.toLocaleString()} rows`);
  } catch (err: any) {
    console.warn(`   ⚠️ PriceSnapshot: ${err.message}`);
  }

  // ── 4. Genre slug map (id → slug) for compact index ──────────────────────
  const genreSlugMap = new Map<string, string>(); // gameId → genre slugs[]
  // We already have gameGenres (gameId → EntityRef[]), extract slugs below.

  const tagSlugMap = new Map<string, string[]>();
  const genreSlugListMap = new Map<string, string[]>();
  for (const [gId, refs] of gameGenres) {
    genreSlugListMap.set(gId, refs.map((r) => r.slug));
  }
  for (const [gId, refs] of gameTags) {
    tagSlugMap.set(gId, refs.map((r) => r.slug));
  }

  // ── 5. Stream games into catalog.raw & build compact index ───────────────
  console.log("\n4. Streaming games into catalog.raw + building compact index...");
  const rawStream = fs.createWriteStream(rawFilePath, { flags: "w", encoding: "utf8" });

  let byteOffset = 0;
  let totalProcessed = 0;
  const compactRecords: CatalogRecord[] = [];

  let page = 0;
  while (true) {
    const batchOffset = page * GAME_BATCH;
    const res = await client.execute({
      sql: `SELECT * FROM "Game" WHERE (status IS NULL OR status != 'hidden') LIMIT ? OFFSET ?`,
      args: [GAME_BATCH, batchOffset],
    });

    if (res.rows.length === 0) break;

    for (const row of res.rows) {
      const gId = String(row.id);
      const slug = String(row.slug);
      const title = String(row.title);
      const releaseDateSec = toEpochSec(row.releaseDate);

      // ---- Full game record (goes into catalog.raw) -----------------------
      const fullRecord = {
        id: gId,
        igdbId: row.igdbId ?? null,
        title,
        slug,
        summary: row.summary ?? null,
        storyline: row.storyline ?? null,
        releaseDate: releaseDateSec,
        status: row.status ?? "released",
        coverUrl: row.coverUrl ?? null,
        rating: row.rating != null ? Math.round(Number(row.rating) * 10) / 10 : null,
        trailerUrl: row.trailerUrl ?? null,
        screenshots: safeJson<string[]>(row.screenshots) ?? [],
        catboxAlbumId: row.catboxAlbumId ?? null,
        metacritic: row.metacritic ?? null,
        metacriticUrl: row.metacriticUrl ?? null,
        playtime: row.playtime ?? null,
        esrbRating: row.esrbRating ?? null,
        pegiRating: row.pegiRating ?? null,
        redditUrl: row.redditUrl ?? null,
        websiteUrl: row.websiteUrl ?? null,
        rawgRating: row.rawgRating != null ? Number(row.rawgRating) : null,
        rawgSlug: row.rawgSlug ?? null,
        steamRating: row.steamRating != null ? Number(row.steamRating) : null,
        steamRatingDesc: row.steamRatingDesc ?? null,
        scareRating: row.scareRating != null ? Number(row.scareRating) : null,
        scareProfile: safeJson(row.scareProfile),
        scareReviewCount: row.scareReviewCount ?? null,
        protonDbTier: row.protonDbTier ?? null,
        protonDbConfidence: row.protonDbConfidence ?? null,
        protonDbScore: row.protonDbScore != null ? Number(row.protonDbScore) : null,
        minRequirements: row.minRequirements ?? null,
        recRequirements: row.recRequirements ?? null,
        popularity: row.popularity != null ? Math.round(Number(row.popularity) * 100) / 100 : null,
        isTrending: Boolean(row.isTrending),
        developerNames: row.developerNames ?? null,
        genreNames: row.genreNames ?? null,
        platformNames: row.platformNames ?? null,
        source: row.source ?? null,
        taxonomyScores: safeJson(row.taxonomyScores),
        devs: (gameDevs.get(gId) || []).map((r) => ({ name: r.name, slug: r.slug })),
        pubs: (gamePubs.get(gId) || []).map((r) => ({ name: r.name, slug: r.slug })),
        genres: (gameGenres.get(gId) || []).map((r) => ({ name: r.name, slug: r.slug })),
        tags: (gameTags.get(gId) || []).map((r) => ({ name: r.name, slug: r.slug })),
        platforms: (gamePlatforms.get(gId) || []).map((r) => ({ name: r.name, slug: r.slug })),
        purchaseLinks: purchaseLinksMap.get(gId) || [],
        priceSnapshots: priceSnapshotsMap.get(gId) || [],
      };

      // Each line in catalog.raw = one JSON game + newline
      const jsonStr = JSON.stringify(fullRecord) + "\n";
      const byteLen = Buffer.byteLength(jsonStr, "utf8");
      rawStream.write(jsonStr);

      // ---- Compact search record (goes into catalog-dump.json.gz) ---------
      compactRecords.push({
        i: gId,
        t: title,
        s: slug,
        c: (row.coverUrl as string) || null,
        dn: (row.developerNames as string) || null,
        pn: (row.platformNames as string) || null,
        rd: releaseDateSec,
        rt: row.rating != null ? Math.round(Number(row.rating)) : null,
        sr: row.steamRating != null ? Math.round(Number(row.steamRating) * 10) / 10 : null,
        mc: (row.metacritic as number) || null,
        rr: row.rawgRating != null ? Math.round(Number(row.rawgRating) * 10) / 10 : null,
        cat: row.category != null ? Number(row.category) : null,
        pop: row.popularity != null ? Math.round(Number(row.popularity) * 10) / 10 : null,
        tr: Boolean(row.isTrending),
        lk: Number(row.likesCount) || 0,
        gs: genreSlugListMap.get(gId) || [],
        ts: tagSlugMap.get(gId) || [],
        dp: priceMinMap.get(gId) ?? null,
        st: (row.status as string) || null,
        // Byte coordinates for Range request into catalog.raw
        o: byteOffset,
        l: byteLen - 1, // Exclude trailing \n for clean JSON parse
      });

      byteOffset += byteLen;
      totalProcessed++;
    }

    page++;
    process.stdout.write(
      `   Processed ${totalProcessed.toLocaleString()} games (batch ${page})...\r`
    );
    if (res.rows.length < GAME_BATCH) break; // Last partial batch
  }

  await new Promise<void>((resolve) => rawStream.end(resolve));
  console.log(
    `\n   ✓ catalog.raw: ${totalProcessed.toLocaleString()} games | ${(byteOffset / (1024 * 1024)).toFixed(2)} MB`
  );

  // ── 6. Write offset-only file (offsets.json.gz) ───────────────────────────
  console.log("\n5. Writing offsets.json.gz...");
  // Format: [{i, o, l}, ...] — minimal file just for range-request lookups
  const offsetsArr = compactRecords.map((r) => ({
    i: r.i,
    s: r.s,
    o: r.o!,
    l: r.l!,
  }));
  const offsetsGz = zlib.gzipSync(Buffer.from(JSON.stringify(offsetsArr), "utf8"), { level: 9 });
  fs.writeFileSync(path.join(docsDir, "offsets.json.gz"), offsetsGz);
  console.log(`   ✓ offsets.json.gz: ${(offsetsGz.length / 1024).toFixed(1)} KB (${offsetsArr.length.toLocaleString()} entries)`);

  // ── 7. Write compact catalog-dump.json.gz (search index + offsets) ────────
  console.log("\n6. Writing catalog-dump.json.gz...");
  const rawJson = JSON.stringify(compactRecords);
  const rawBuf = Buffer.from(rawJson, "utf8");
  const gzipBuf = zlib.gzipSync(rawBuf, { level: 9 });
  fs.writeFileSync(path.join(docsDir, "catalog-dump.json.gz"), gzipBuf);
  console.log(`   ✓ catalog-dump.json.gz: ${(gzipBuf.length / (1024 * 1024)).toFixed(2)} MB (${((gzipBuf.length / rawBuf.length) * 100).toFixed(1)}% of ${(rawBuf.length / (1024 * 1024)).toFixed(2)} MB uncompressed)`);

  // ── 8. Write manifest ─────────────────────────────────────────────────────
  const now = new Date();
  const version =
    now.toISOString().slice(0, 10).replace(/-/g, ".") +
    "." +
    String(now.getUTCHours()).padStart(2, "0") +
    String(now.getUTCMinutes()).padStart(2, "0");

  const manifest = {
    version,
    totalGames: compactRecords.length,
    rawBytes: byteOffset,
    rawMb: parseFloat((byteOffset / (1024 * 1024)).toFixed(2)),
    compressedBytes: gzipBuf.length,
    uncompressedBytes: rawBuf.length,
    compressedMb: parseFloat((gzipBuf.length / (1024 * 1024)).toFixed(2)),
    uncompressedMb: parseFloat((rawBuf.length / (1024 * 1024)).toFixed(2)),
    hfDataset: "aurostron/hogamegata",
    hfFile: "catalog.raw",
    updatedAt: now.toISOString(),
  };
  fs.writeFileSync(
    path.join(docsDir, "catalog-manifest.json"),
    JSON.stringify(manifest, null, 2)
  );
  console.log("   ✓ catalog-manifest.json written");

  // ── 9. Summary ────────────────────────────────────────────────────────────
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log("\n===========================================================");
  console.log(`🎉  DONE in ${elapsed}s`);
  console.log(`    Games: ${compactRecords.length.toLocaleString()}`);
  console.log(`    catalog.raw:            ${manifest.rawMb} MB  →  dist-hf/`);
  console.log(`    catalog-dump.json.gz:   ${manifest.compressedMb} MB  →  docs/public/`);
  console.log(`    offsets.json.gz:        ${(offsetsGz.length / 1024).toFixed(1)} KB  →  docs/public/`);
  console.log("===========================================================\n");
}

generateCatalogDump().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
