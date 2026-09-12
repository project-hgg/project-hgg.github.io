import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { d1Client as client } from "./d1-client.js";

interface CatalogRecord {
  i: string;           // id
  t: string;           // title
  s: string;           // slug
  c: string | null;    // coverUrl
  dn: string | null;   // developerNames
  pn: string | null;   // platformNames
  rd: number | null;   // releaseDate as unix epoch seconds
  rt: number | null;   // rating (0-100)
  sr: number | null;   // steamRating (0-10)
  mc: number | null;   // metacritic
  rr: number | null;   // rawgRating (0-5)
  cat: number | null;  // category
  pop: number | null;  // popularity
  tr: boolean;         // isTrending
  lk: number;          // likesCount
  gs: string[];        // genre slugs
  ts: string[];        // tag slugs
  dp: number | null;   // cheapest deal price
  st: string | null;   // status
}

async function generateCatalogDump() {
  const startTime = performance.now();
  console.log("==================================================");
  console.log("📦 PROJECT-HGG: GENERATING GZIP CATALOG DUMP");
  console.log("==================================================\n");

  console.log("1. Fetching all visible games from Cloudflare D1...");
  const gamesRes = await client.execute(`
    SELECT 
      id, title, slug, coverUrl, developerNames, platformNames, 
      releaseDate, rating, steamRating, metacritic, rawgRating, 
      category, popularity, isTrending, likesCount, status 
    FROM "Game" 
    WHERE status IS NULL OR status != 'hidden'
  `);
  const games = gamesRes.rows;
  console.log(`   ✓ Retrieved ${games.length.toLocaleString()} visible games in ${((performance.now() - startTime) / 1000).toFixed(1)}s`);

  console.log("2. Fetching genre mappings...");
  const genreMap = new Map<string, string[]>();
  try {
    const genreRes = await client.execute(`
      SELECT gtg."A" as gameId, g.slug as slug 
      FROM "_GameToGenre" gtg 
      JOIN "Genre" g ON gtg."B" = g.id
    `);
    for (const row of genreRes.rows) {
      const gid = row.gameId as string;
      const slug = row.slug as string;
      if (!gid || !slug) continue;
      if (!genreMap.has(gid)) genreMap.set(gid, []);
      genreMap.get(gid)!.push(slug);
    }
    console.log(`   ✓ Mapped ${genreRes.rows.length.toLocaleString()} genre associations across ${genreMap.size.toLocaleString()} games`);
  } catch (err: any) {
    console.warn("   ⚠️ Warning: Failed to query genres:", err.message);
  }

  console.log("3. Fetching tag mappings...");
  const tagMap = new Map<string, string[]>();
  try {
    const tagRes = await client.execute(`
      SELECT gtt."A" as gameId, t.slug as slug 
      FROM "_GameToTag" gtt 
      JOIN "Tag" t ON gtt."B" = t.id
    `);
    for (const row of tagRes.rows) {
      const gid = row.gameId as string;
      const slug = row.slug as string;
      if (!gid || !slug) continue;
      if (!tagMap.has(gid)) tagMap.set(gid, []);
      tagMap.get(gid)!.push(slug);
    }
    console.log(`   ✓ Mapped ${tagRes.rows.length.toLocaleString()} tag associations across ${tagMap.size.toLocaleString()} games`);
  } catch (err: any) {
    console.warn("   ⚠️ Warning: Failed to query tags:", err.message);
  }

  console.log("4. Fetching deal prices from PriceSnapshot...");
  const priceMap = new Map<string, number>();
  try {
    const priceRes = await client.execute(`
      SELECT gameId, MIN(dealPrice) as minPrice 
      FROM "PriceSnapshot" 
      GROUP BY gameId
    `);
    for (const row of priceRes.rows) {
      const gid = row.gameId as string;
      const p = row.minPrice as number | null;
      if (gid && p != null) {
        priceMap.set(gid, p);
      }
    }
    console.log(`   ✓ Mapped deal prices for ${priceMap.size.toLocaleString()} games`);
  } catch (err: any) {
    console.warn("   ⚠️ Warning: Failed to query prices:", err.message);
  }

  console.log("5. Assembling compact sanitized records...");
  const records: CatalogRecord[] = games.map((g: any) => {
    let rdSec: number | null = null;
    if (g.releaseDate != null) {
      const num = Number(g.releaseDate);
      if (!isNaN(num) && num > 0) {
        rdSec = num > 100000000000 ? Math.floor(num / 1000) : num;
      }
    }

    return {
      i: g.id,
      t: g.title,
      s: g.slug,
      c: g.coverUrl || null,
      dn: g.developerNames || null,
      pn: g.platformNames || null,
      rd: rdSec,
      rt: g.rating != null ? Math.round(g.rating) : null,
      sr: g.steamRating != null ? Math.round(g.steamRating * 10) / 10 : null,
      mc: g.metacritic || null,
      rr: g.rawgRating != null ? Math.round(g.rawgRating * 10) / 10 : null,
      cat: g.category != null ? g.category : null,
      pop: g.popularity != null ? Math.round(g.popularity * 10) / 10 : null,
      tr: Boolean(g.isTrending),
      lk: g.likesCount || 0,
      gs: genreMap.get(g.id) || [],
      ts: tagMap.get(g.id) || [],
      dp: priceMap.get(g.id) ?? null,
      st: g.status || null,
    };
  });

  console.log("6. Serializing JSON and compressing with Gzip...");
  const rawJson = JSON.stringify(records);
  const rawBuffer = Buffer.from(rawJson, "utf-8");
  const rawBytes = rawBuffer.length;
  const rawMb = (rawBytes / (1024 * 1024)).toFixed(2);

  const gzipBuffer = zlib.gzipSync(rawBuffer, { level: 9 });
  const gzipBytes = gzipBuffer.length;
  const gzipMb = (gzipBytes / (1024 * 1024)).toFixed(2);

  console.log(`   ✓ Uncompressed size: ${rawMb} MB`);
  console.log(`   ✓ Gzip compressed size: ${gzipMb} MB (${((gzipBytes / rawBytes) * 100).toFixed(1)}% of original)`);

  const now = new Date();
  const version = now.toISOString().slice(0, 10).replace(/-/g, ".") + "." + String(now.getUTCHours()).padStart(2, "0") + String(now.getUTCMinutes()).padStart(2, "0");

  const manifest = {
    version,
    totalGames: records.length,
    compressedBytes: gzipBytes,
    uncompressedBytes: rawBytes,
    compressedMb: parseFloat(gzipMb),
    uncompressedMb: parseFloat(rawMb),
    updatedAt: now.toISOString(),
  };

  const outDir = path.resolve(process.cwd(), "docs", "public");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  fs.writeFileSync(path.join(outDir, "catalog-manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "catalog-dump.json.gz"), gzipBuffer);
  console.log(`   ✓ Saved catalog files to ${outDir}`);

  const totalTime = ((performance.now() - startTime) / 1000).toFixed(1);
  console.log("\n==================================================");
  console.log(`🎉 CATALOG DUMP READY in ${totalTime}s`);
  console.log(`   Version: ${version} | Total: ${records.length.toLocaleString()} | Size: ${gzipMb} MB`);
  console.log("==================================================\n");
}

generateCatalogDump().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
