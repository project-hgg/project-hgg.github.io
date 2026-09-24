import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { uploadFilesWithProgress } from "@huggingface/hub";
import { writeTodoMarkdown } from "./todo-helper.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface OffsetEntry {
  i: string;
  s: string;
  o: number;
  l: number;
}

interface CatalogRecord {
  i: string;
  t: string;
  s: string;
  c: string | null;
  dn: string | null;
  pn: string | null;
  rd: number | null;
  rt: number | null;
  sr: number | null;
  mc: number | null;
  rr: number | null;
  cat: number | null;
  pop: number | null;
  tr: boolean;
  lk: number;
  gs: string[];
  ts: string[];
  dp: number | null;
  st: string | null;
  o?: number;
  l?: number;
}

interface PendingGame {
  id: string;
  title: string;
  slug: string;
  coverUrl?: string | null;
  author?: string;
  developerNames?: string | null;
  platformNames?: string | null;
  tags?: string | string[];
  status?: string;
  source?: string;
  dealPrice?: number | null;
  retailPrice?: number | null;
  discountPercent?: number | null;
  url?: string;
  purchaseLinks?: { store: string; url: string }[];
  summary?: string | null;
  firstReleaseDate?: number | null;
  releaseDate?: number | null;
  totalRating?: number | null;
  rating?: number | null;
  queuedAt?: string;
  failureReason?: string;
  _type?: string;
}

const HF_DATASET = "aurostron/hogamegata";
const HF_RAW_FILENAME = "catalog.raw";
const HF_RAW_URL = `https://huggingface.co/datasets/${HF_DATASET}/resolve/main/${HF_RAW_FILENAME}`;

function slugify(text: string): string {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

/**
 * Downloads or copies the current master catalog.raw so we can update it incrementally
 */
async function ensureMasterCatalogRaw(targetPath: string, hfToken?: string): Promise<number> {
  // 1. If it already exists on disk and is > 50 MB, use it
  if (fs.existsSync(targetPath)) {
    const stat = fs.statSync(targetPath);
    if (stat.size > 50 * 1024 * 1024) {
      console.log(`📦 Found existing local catalog.raw (${(stat.size / (1024 * 1024)).toFixed(2)} MB)`);
      return stat.size;
    }
  }

  // 2. Check peer repository in local workspace (gamegata-astro/data-export/catalog.raw)
  const peerExport = path.resolve("..", "gamegata-astro", "data-export", "catalog.raw");
  if (fs.existsSync(peerExport)) {
    console.log(`📂 Found local master catalog at ${peerExport}. Copying...`);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(peerExport, targetPath);
    const stat = fs.statSync(targetPath);
    console.log(`✅ Copied ${(stat.size / (1024 * 1024)).toFixed(2)} MB catalog.raw`);
    return stat.size;
  }

  // 3. Download from Hugging Face dataset
  console.log(`⬇️ Downloading master catalog.raw from Hugging Face dataset (${HF_DATASET})...`);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const headers: Record<string, string> = {
    "User-Agent": "gamegata-catalog-sync/1.0",
  };
  if (hfToken) {
    headers["Authorization"] = `Bearer ${hfToken}`;
  }

  const res = await fetch(HF_RAW_URL, { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch catalog.raw from Hugging Face: ${res.status} ${res.statusText}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("Could not acquire reader stream for Hugging Face download");

  const writeStream = fs.createWriteStream(targetPath);
  let totalBytes = 0;
  let lastLoggedMb = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    writeStream.write(Buffer.from(value));
    totalBytes += value.length;
    const currentMb = Math.floor(totalBytes / (25 * 1024 * 1024)) * 25;
    if (currentMb > lastLoggedMb) {
      lastLoggedMb = currentMb;
      process.stdout.write(`   Downloaded ${(totalBytes / (1024 * 1024)).toFixed(1)} MB...\r`);
    }
  }
  await new Promise<void>((resolve) => writeStream.end(resolve));

  console.log(`\n✅ Download complete: ${(totalBytes / (1024 * 1024)).toFixed(2)} MB written to ${targetPath}`);
  return totalBytes;
}

/**
 * Builds the full JSON game representation as expected by gamePackFetcher
 */
function buildFullGameRecord(g: PendingGame): any {
  const authorName = g.author || g.developerNames || "Independent Creator";
  const rawTags = Array.isArray(g.tags)
    ? g.tags
    : typeof g.tags === "string"
    ? g.tags.split(",").map((s) => s.trim()).filter(Boolean)
    : ["Horror", "Indie"];

  const pLinks = g.purchaseLinks
    ? g.purchaseLinks.map((p) => ({ storeName: p.store, url: p.url }))
    : g.url
    ? [{ storeName: g.source || "itch.io", url: g.url }]
    : [];

  const prices = g.dealPrice != null
    ? [{
        storeName: g.source || "itch.io",
        dealPrice: g.dealPrice,
        retailPrice: g.retailPrice ?? g.dealPrice,
        discountPercent: g.discountPercent ?? 0,
        dealUrl: g.url ?? null,
        currency: "USD",
        country: "US",
        provider: "direct",
      }]
    : [];

  return {
    id: g.id,
    igdbId: null,
    title: g.title,
    slug: g.slug,
    summary: g.summary ?? null,
    storyline: null,
    releaseDate: g.releaseDate ?? g.firstReleaseDate ?? Math.floor(Date.now() / 1000),
    status: g.status || "released",
    coverUrl: g.coverUrl || null,
    rating: g.rating ?? g.totalRating ?? null,
    trailerUrl: null,
    screenshots: [],
    catboxAlbumId: null,
    metacritic: null,
    metacriticUrl: null,
    playtime: null,
    esrbRating: null,
    pegiRating: null,
    redditUrl: null,
    websiteUrl: null,
    rawgRating: null,
    rawgSlug: null,
    steamRating: null,
    steamRatingDesc: null,
    scareRating: null,
    scareProfile: null,
    scareReviewCount: null,
    protonDbTier: null,
    protonDbConfidence: null,
    protonDbScore: null,
    minRequirements: null,
    recRequirements: null,
    popularity: 1,
    isTrending: false,
    developerNames: authorName,
    genreNames: "Horror",
    platformNames: g.platformNames || "PC (Microsoft Windows)",
    source: g.source || (g.slug.startsWith("itch-") ? "itch" : "igdb"),
    taxonomyScores: null,
    devs: [{ name: authorName, slug: slugify(authorName) }],
    pubs: [],
    genres: [{ name: "Horror", slug: "horror" }],
    tags: rawTags.map((t) => ({ name: t, slug: slugify(t) })),
    platforms: [{ name: "PC (Microsoft Windows)", slug: "pc-microsoft-windows" }],
    purchaseLinks: pLinks,
    priceSnapshots: prices,
  };
}

function generateCreatorIndexFromCatalog(catalog: DumpGame[], outPath: string) {
  const creatorMap: Record<string, { name: string; slug: string; games: any[] }> = {};
  for (const g of catalog) {
    if (!g.dn) continue;
    const creators = g.dn.split(",").map((s: string) => s.trim()).filter(Boolean);
    const card = {
      id: g.i,
      title: g.t,
      slug: g.s,
      coverUrl: g.c || null,
      developerNames: g.dn || null,
      platformNames: g.pn || "PC (Microsoft Windows)",
      releaseDate: g.rd ? (g.rd > 100000000000 ? g.rd : g.rd * 1000) : null,
      rating: g.rt ?? null,
      status: g.st || "released",
      category: g.cat ?? null,
      genres: (g.gs || ["horror"]).map((x: string) => ({ name: x, slug: x })),
      tags: (g.ts || []).map((x: string) => ({ name: x, slug: x })),
    };
    for (const c of creators) {
      const slug = slugify(c);
      if (!slug) continue;
      if (!creatorMap[slug]) {
        creatorMap[slug] = {
          name: c,
          slug,
          games: [],
        };
      }
      creatorMap[slug].games.push(card);
    }
  }

  const filteredMap: Record<string, { name: string; slug: string; games: any[] }> = {};
  let multiCount = 0;
  for (const [slug, profile] of Object.entries(creatorMap)) {
    if (profile.games.length > 1) {
      profile.games.sort((a: any, b: any) => {
        const timeA = a.releaseDate || 0;
        const timeB = b.releaseDate || 0;
        if (timeA && timeB) return timeB - timeA;
        return (b.rating || 0) - (a.rating || 0);
      });
      filteredMap[slug] = profile;
      multiCount++;
    }
  }

  const outJson = JSON.stringify(filteredMap);
  const outGz = zlib.gzipSync(Buffer.from(outJson, "utf8"), { level: 9 });
  fs.writeFileSync(outPath, outGz);
  console.log(`   ✓ creator-games.json.gz written (${(outGz.length / 1024 / 1024).toFixed(2)} MB for ${multiCount.toLocaleString()} creators)`);
}

function generateUpcomingIndexFromCatalog(catalog: DumpGame[], outPath: string) {
  const nowSec = Math.floor(Date.now() / 1000);
  const up = catalog.filter((g: any) => g.st === "upcoming" || (g.rd && g.rd > nowSec));

  const list = up.map((g: any) => ({
    id: g.i,
    title: g.t,
    slug: g.s,
    coverUrl: g.c || null,
    developerNames: g.dn || null,
    platformNames: g.pn || "PC (Microsoft Windows)",
    releaseDate: g.rd ? (g.rd > 100000000000 ? g.rd : g.rd * 1000) : null,
    rating: g.rt ?? null,
    status: g.st || "upcoming",
    category: g.cat ?? null,
    isTrending: Boolean(g.tr),
    tags: (g.ts || []).map((t: string) => ({ name: t, slug: t })),
    genres: (g.gs || []).map((gen: string) => ({ name: gen, slug: gen })),
    purchaseLinks: [],
  }));

  list.sort((a: any, b: any) => (a.releaseDate || 9999999999999) - (b.releaseDate || 9999999999999));

  const outJson = JSON.stringify(list);
  const outGz = zlib.gzipSync(Buffer.from(outJson, "utf8"), { level: 9 });
  fs.writeFileSync(outPath, outGz);
  console.log(`   ✓ upcoming-games.json.gz written (${(outGz.length / 1024).toFixed(1)} KB for ${list.length.toLocaleString()} games)`);
}

/**
 * Normalizes slug to determine its shard key:
 * - strips leading "itch-" so itch titles are distributed across letters
 * - returns 'a'..'z' or '_num'
 */
export function getShardKey(slug: string): string {
  let s = slug.toLowerCase().trim();
  if (s.startsWith("itch-")) {
    s = s.slice(5);
  }
  const firstChar = s.charAt(0);
  if (!firstChar || !/[a-z]/.test(firstChar)) {
    return "_num";
  }
  return firstChar;
}

function generateShardedOffsets(
  offsetsDict: Record<string, [number, number]>,
  outputDir: string
): string[] {
  const shardsDir = path.join(outputDir, "offsets");
  fs.mkdirSync(shardsDir, { recursive: true });

  const shards: Record<string, Record<string, [number, number]>> = {
    _num: {},
  };
  for (let i = 97; i <= 122; i++) {
    shards[String.fromCharCode(i)] = {};
  }

  for (const [slugOrId, coords] of Object.entries(offsetsDict)) {
    const shardKey = getShardKey(slugOrId);
    if (!shards[shardKey]) {
      shards[shardKey] = {};
    }
    shards[shardKey][slugOrId] = coords;
  }

  const generatedFiles: string[] = [];
  for (const [shardKey, dict] of Object.entries(shards)) {
    const filePath = path.join(shardsDir, `${shardKey}.json`);
    fs.writeFileSync(filePath, JSON.stringify(dict));
    generatedFiles.push(filePath);
  }

  console.log(`   ✓ Sharded ${Object.keys(offsetsDict).length.toLocaleString()} offsets into ${generatedFiles.length} shards in docs/public/offsets/`);
  return generatedFiles;
}

function generateHomepageFeed(catalog: DumpGame[], outPath: string) {
  const nowSec = Math.floor(Date.now() / 1000);

  // Load rich fallback games to guarantee verified screenshots and trailer metadata for hero
  let baseFallback: any[] = [];
  try {
    const localFallbackPath = path.join(__dirname, "homepageFallback.json");
    const peerFallbackPath = path.resolve("..", "gamegata-astro", "src", "data", "homepageFallback.json");
    if (fs.existsSync(localFallbackPath)) {
      baseFallback = JSON.parse(fs.readFileSync(localFallbackPath, "utf8"));
    } else if (fs.existsSync(peerFallbackPath)) {
      baseFallback = JSON.parse(fs.readFileSync(peerFallbackPath, "utf8"));
    }
  } catch {}

  const toCard = (g: any) => ({
    id: g.i || g.id,
    title: g.t || g.title,
    slug: g.s || g.slug,
    status: g.st || g.status || "released",
    coverUrl: g.c || g.coverUrl || null,
    rating: g.rt ?? g.rating ?? null,
    category: g.cat ?? g.category ?? null,
    esrbRating: g.esrbRating || null,
    pegiRating: g.pegiRating || null,
    developerNames: g.dn || g.developerNames || null,
    genreNames: Array.isArray(g.gs) ? g.gs.join(", ") : (g.genreNames || null),
    platformNames: g.pn || g.platformNames || "PC (Microsoft Windows)",
    releaseDate: g.rd ? (g.rd > 100000000000 ? g.rd : g.rd * 1000) : (g.releaseDate || null),
    trailerUrl: g.trailerUrl || null,
    isTrending: Boolean(g.tr ?? g.isTrending),
    screenshots: g.screenshots && g.screenshots.length > 0 ? g.screenshots : (g.c ? [g.c] : []),
    tags: Array.isArray(g.ts) 
      ? g.ts.map((t: string) => ({ name: t, slug: t.toLowerCase().replace(/[^a-z0-9]+/g, "-") })) 
      : (g.tags || []),
    purchaseLinks: g.purchaseLinks || [],
    priceSnapshots: g.priceSnapshots || (g.dp ? [{
      storeName: "itch.io",
      dealPrice: g.dp,
      retailPrice: g.dp,
      discountPercent: 0,
      dealUrl: null,
      currency: "USD",
      country: "US"
    }] : [])
  });

  // 1. Hero: Top curated games with high-res screenshots
  const heroCandidates = baseFallback.filter((g: any) => g.screenshots && g.screenshots.length > 0);
  const heroGames = (heroCandidates.length >= 6 ? heroCandidates.slice(0, 12) : baseFallback).map(toCard);

  // 2. Top Rated: Rated >= 75, sorted by rating descending
  const topRated = [...catalog]
    .filter((g: any) => g.rt != null && g.rt >= 75 && g.st !== "hidden")
    .sort((a: any, b: any) => (b.rt || 0) - (a.rt || 0))
    .slice(0, 20)
    .map(toCard);

  // 3. Trending: marked as trending or high popularity
  const trending = [...catalog]
    .filter((g: any) => g.st !== "hidden" && (g.tr || (g.pop && g.pop > 10)))
    .sort((a: any, b: any) => (b.pop || 0) - (a.pop || 0))
    .slice(0, 30)
    .map(toCard);

  // 4. Upcoming: future releaseDate or status === 'upcoming'
  const upcoming = [...catalog]
    .filter((g: any) => g.st !== "hidden" && ((g.rd && g.rd > nowSec) || g.st === "upcoming"))
    .sort((a: any, b: any) => (a.rd || 9999999999) - (b.rd || 9999999999))
    .slice(0, 15)
    .map(toCard);

  // 5. Latest: valid past releaseDate, sorted descending
  const latest = [...catalog]
    .filter((g: any) => g.st !== "hidden" && g.st !== "upcoming" && g.rd && g.rd <= nowSec)
    .sort((a: any, b: any) => (b.rd || 0) - (a.rd || 0))
    .slice(0, 30)
    .map(toCard);

  const feed = {
    updatedAt: new Date().toISOString(),
    heroGames: heroGames.length > 0 ? heroGames : baseFallback.map(toCard),
    latestGames: latest.length > 0 ? latest : baseFallback.map(toCard),
    trendingGames: trending.length > 0 ? trending : baseFallback.map(toCard),
    upcomingGames: upcoming,
    topRatedGames: topRated.length > 0 ? topRated : baseFallback.map(toCard),
    stats: {
      games: catalog.length,
      developers: 68034,
      tags: 15825,
      deals: 111168
    }
  };

  fs.writeFileSync(outPath, JSON.stringify(feed, null, 2), "utf8");
  console.log(`   ✓ homepage-feed.json written (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
  return feed;
}

async function uploadToHuggingFace(
  rawFilePath: string,
  hfToken: string,
  extraFiles: Array<{ path: string; filePath: string }> = []
) {
  console.log(`\n🚀 Uploading catalog files to Hugging Face dataset (${HF_DATASET})...`);
  const fileBuffer = fs.readFileSync(rawFilePath);

  const filesToUpload: any[] = [
    {
      path: HF_RAW_FILENAME,
      content: new Blob([fileBuffer]),
    },
  ];

  for (const f of extraFiles) {
    if (fs.existsSync(f.filePath)) {
      filesToUpload.push({
        path: f.path,
        content: new Blob([fs.readFileSync(f.filePath)]),
      });
    }
  }

  const progress = uploadFilesWithProgress({
    repo: { type: "dataset", name: HF_DATASET },
    credentials: { accessToken: hfToken },
    files: filesToUpload,
    commitMessage: `chore(catalog): auto-update master catalog & indices (${new Date().toISOString()})`,
  });

  for await (const event of progress) {
    if (event.event === "phase") {
      console.log(`   HF Status: ${event.phase}...`);
    }
  }

  console.log(`🎉 Successfully uploaded ${filesToUpload.length} files to https://huggingface.co/datasets/${HF_DATASET}!`);
}

async function main() {
  const startTime = Date.now();
  console.log("==========================================================");
  console.log("🎮 HUGGING FACE MASTER CATALOG GENERATOR & SYNC");
  console.log("   (Zero-D1 Architecture — 100% Free & Quota-Independent)");
  console.log("==========================================================\n");

  const hfToken = process.env.HF_TOKEN || "";
  const docsDir = path.join(process.cwd(), "docs", "public");
  const distDir = path.join(process.cwd(), "dist-hf");
  const rawFilePath = path.join(distDir, HF_RAW_FILENAME);

  fs.mkdirSync(docsDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });

  // 1. Ensure master catalog.raw exists (download from HF or copy local)
  let currentRawSize = await ensureMasterCatalogRaw(rawFilePath, hfToken);

  // 2. Load existing offsets and catalog-dump
  const offsetsPath = path.join(docsDir, "offsets.json.gz");
  const dumpPath = path.join(docsDir, "catalog-dump.json.gz");
  const pendingPath = path.join(docsDir, "pending-games.json");

  console.log("\n📂 Loading existing offsets and compact catalog...");
  const offsetsDict: Record<string, [number, number]> = {};
  const offsetsMap = new Map<string, [number, number]>(); // slug or id -> [offset, length]

  if (fs.existsSync(offsetsPath)) {
    try {
      const rawOffsets = zlib.gunzipSync(fs.readFileSync(offsetsPath)).toString("utf-8");
      const parsed = JSON.parse(rawOffsets);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.s && item.o != null && item.l != null) {
            offsetsMap.set(item.s, [item.o, item.l]);
            offsetsDict[item.s] = [item.o, item.l];
            if (item.i) offsetsDict[item.i] = [item.o, item.l];
          }
        }
      } else if (parsed && typeof parsed === "object") {
        for (const [key, val] of Object.entries(parsed)) {
          if (Array.isArray(val) && val.length >= 2) {
            offsetsMap.set(key, [val[0] as number, val[1] as number]);
            offsetsDict[key] = [val[0] as number, val[1] as number];
          }
        }
      }
      console.log(`   ✓ Loaded ${Object.keys(offsetsDict).length.toLocaleString()} existing offsets from offsets.json.gz`);
    } catch (e: any) {
      console.warn(`   ⚠️ Could not read offsets.json.gz: ${e.message}`);
    }
  }

  let catalog: CatalogRecord[] = [];
  if (fs.existsSync(dumpPath)) {
    try {
      catalog = JSON.parse(zlib.gunzipSync(fs.readFileSync(dumpPath)).toString("utf-8"));
      console.log(`   ✓ Loaded ${catalog.length.toLocaleString()} games from catalog-dump.json.gz`);
    } catch (e: any) {
      console.warn(`   ⚠️ Could not read catalog-dump.json.gz: ${e.message}`);
    }
  }

  // 3. Collect pending games to append
  const pendingGames: PendingGame[] = [];
  if (fs.existsSync(pendingPath)) {
    try {
      const list: PendingGame[] = JSON.parse(fs.readFileSync(pendingPath, "utf-8"));
      for (const g of list) {
        if (g && g.slug && g._type !== "canonicalLink") {
          pendingGames.push(g);
        }
      }
      console.log(`   ✓ Found ${pendingGames.length} pending games in pending-games.json`);
    } catch {}
  }

  // Also check if any games in catalog-dump are missing offsets
  for (const c of catalog) {
    if (!offsetsMap.has(c.s)) {
      if (!pendingGames.some((p) => p.slug === c.s)) {
        pendingGames.push({
          id: c.i,
          title: c.t,
          slug: c.s,
          coverUrl: c.c,
          author: c.dn || "Independent Creator",
          tags: c.ts || ["Horror"],
          status: c.st || "released",
          releaseDate: c.rd,
          rating: c.rt,
        });
      }
    }
  }

  console.log(`\n🔍 Total unindexed / pending games to append to master dataset: ${pendingGames.length}`);

  // 4. Append new games to catalog.raw & calculate exact byte offsets
  let appendedCount = 0;
  if (pendingGames.length > 0) {
    console.log("✍️ Appending new games to catalog.raw...");
    const rawAppendStream = fs.createWriteStream(rawFilePath, { flags: "a", encoding: "utf8" });

    for (const g of pendingGames) {
      if (offsetsMap.has(g.slug)) continue;

      const fullRecord = buildFullGameRecord(g);
      const jsonLine = JSON.stringify(fullRecord) + "\n";
      const lineBuffer = Buffer.from(jsonLine, "utf8");
      const length = lineBuffer.length;
      const offset = currentRawSize;

      rawAppendStream.write(jsonLine);
      currentRawSize += length;

      const cleanLen = length - 1; // Exclude trailing newline
      offsetsMap.set(g.slug, [offset, cleanLen]);
      offsetsDict[g.slug] = [offset, cleanLen];
      offsetsDict[g.id] = [offset, cleanLen];

      // Update compact catalog record
      const catEntry = catalog.find((c) => c.s === g.slug);
      if (catEntry) {
        catEntry.o = offset;
        catEntry.l = cleanLen;
      } else {
        catalog.push({
          i: g.id,
          t: g.title,
          s: g.slug,
          c: g.coverUrl || null,
          dn: g.author || null,
          pn: g.platformNames || "PC (Microsoft Windows)",
          rd: g.releaseDate || Math.floor(Date.now() / 1000),
          rt: g.rating ?? null,
          sr: null,
          mc: null,
          rr: null,
          cat: 0,
          pop: 1,
          tr: false,
          lk: 0,
          gs: ["horror"],
          ts: Array.isArray(g.tags) ? g.tags : ["indie", "horror"],
          dp: g.dealPrice ?? null,
          st: g.status || "released",
          o: offset,
          l: cleanLen,
        });
      }
      appendedCount++;
    }

    await new Promise<void>((resolve) => rawAppendStream.end(resolve));
    console.log(`✅ Appended ${appendedCount} new games. New catalog.raw size: ${(currentRawSize / (1024 * 1024)).toFixed(2)} MB`);
  }

  // 5. Write updated offsets.json.gz & generate lightweight shards
  console.log("\n📦 Saving updated docs/public/offsets.json.gz & shards...");
  const offsetsGz = zlib.gzipSync(Buffer.from(JSON.stringify(offsetsDict), "utf8"), { level: 9 });
  fs.writeFileSync(offsetsPath, offsetsGz);
  console.log(`   ✓ offsets.json.gz: ${(offsetsGz.length / 1024).toFixed(1)} KB (${Object.keys(offsetsDict).length.toLocaleString()} entries)`);
  generateShardedOffsets(offsetsDict, docsDir);

  // 6. Write updated catalog-dump.json.gz
  console.log("📦 Saving updated docs/public/catalog-dump.json.gz...");
  const dumpGz = zlib.gzipSync(Buffer.from(JSON.stringify(catalog), "utf8"), { level: 9 });
  fs.writeFileSync(dumpPath, dumpGz);
  console.log(`   ✓ catalog-dump.json.gz: ${(dumpGz.length / (1024 * 1024)).toFixed(2)} MB (${catalog.length.toLocaleString()} entries)`);

  // 6b. Write Creator Games index, Upcoming Games index & Homepage Feed (zero-DB lookups)
  const creatorIndexPath = path.join(docsDir, "creator-games.json.gz");
  generateCreatorIndexFromCatalog(catalog, creatorIndexPath);

  const upcomingIndexPath = path.join(docsDir, "upcoming-games.json.gz");
  generateUpcomingIndexFromCatalog(catalog, upcomingIndexPath);

  const homepageFeedPath = path.join(docsDir, "homepage-feed.json");
  generateHomepageFeed(catalog, homepageFeedPath);

  // 7. Write updated catalog-manifest.json
  const now = new Date();
  const version = `${now.toISOString().slice(0, 10).replace(/-/g, ".")}.${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}`;
  const manifest = {
    version,
    totalGames: catalog.length,
    rawBytes: currentRawSize,
    rawMb: parseFloat((currentRawSize / (1024 * 1024)).toFixed(2)),
    compressedBytes: dumpGz.length,
    compressedMb: parseFloat((dumpGz.length / (1024 * 1024)).toFixed(2)),
    offsetsBytes: offsetsGz.length,
    hfDataset: HF_DATASET,
    hfFile: HF_RAW_FILENAME,
    updatedAt: now.toISOString(),
    newGamesAppended: appendedCount,
  };
  fs.writeFileSync(path.join(docsDir, "catalog-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log("   ✓ catalog-manifest.json written");

  // Update pending queue: mark merged games with inHf: true, remove if also inD1
  if (fs.existsSync(pendingPath)) {
    try {
      const rawPending = JSON.parse(fs.readFileSync(pendingPath, "utf-8"));
      if (Array.isArray(rawPending)) {
        const updatedPending = rawPending
          .map((item: any) => ({ ...item, inHf: true }))
          .filter((item: any) => !(item.inD1 && item.inHf));
        fs.writeFileSync(pendingPath, JSON.stringify(updatedPending, null, 2), "utf-8");
        writeTodoMarkdown(updatedPending);
        console.log(`   ✓ Updated pending-games.json & todo.md (${updatedPending.length} entries awaiting D1 retry)`);
      }
    } catch {}
  }

  // Sync to peer repository if running locally
  const peerDocsDump = path.resolve("..", "gamegata-astro", "public", "catalog", "catalog-dump.json.gz");
  const peerDocsOffsets = path.resolve("..", "gamegata-astro", "public", "catalog", "offsets.json.gz");
  const peerDocsCreator = path.resolve("..", "gamegata-astro", "public", "catalog", "creator-games.json.gz");
  const peerDocsUpcoming = path.resolve("..", "gamegata-astro", "public", "catalog", "upcoming-games.json.gz");
  const peerOffsetsDir = path.resolve("..", "gamegata-astro", "public", "catalog", "offsets");
  const peerHomepageFeed = path.resolve("..", "gamegata-astro", "src", "data", "homepage-feed.json");
  const peerPublicFeed = path.resolve("..", "gamegata-astro", "public", "catalog", "homepage-feed.json");

  if (fs.existsSync(path.dirname(peerDocsDump))) {
    try {
      fs.copyFileSync(dumpPath, peerDocsDump);
      fs.copyFileSync(offsetsPath, peerDocsOffsets);
      if (fs.existsSync(creatorIndexPath)) {
        fs.copyFileSync(creatorIndexPath, peerDocsCreator);
      }
      if (fs.existsSync(upcomingIndexPath)) {
        fs.copyFileSync(upcomingIndexPath, peerDocsUpcoming);
      }
      // Sync shards
      const localShardsDir = path.join(docsDir, "offsets");
      if (fs.existsSync(localShardsDir)) {
        fs.mkdirSync(peerOffsetsDir, { recursive: true });
        for (const file of fs.readdirSync(localShardsDir)) {
          fs.copyFileSync(path.join(localShardsDir, file), path.join(peerOffsetsDir, file));
        }
      }
      // Sync homepage feed
      if (fs.existsSync(homepageFeedPath)) {
        fs.mkdirSync(path.dirname(peerHomepageFeed), { recursive: true });
        fs.copyFileSync(homepageFeedPath, peerHomepageFeed);
        fs.copyFileSync(homepageFeedPath, peerPublicFeed);
      }
      console.log("   ✓ Synced catalog-dump, offsets, shards, creator-games, upcoming-games & homepage-feed to gamegata-astro peer repo!");
    } catch (peerErr: any) {
      console.warn("   ⚠️ Peer sync warning:", peerErr.message);
    }
  }

  // 8. Upload to Hugging Face
  if (hfToken) {
    try {
      await uploadToHuggingFace(rawFilePath, hfToken, [
        { path: "catalog-dump.json.gz", filePath: dumpPath },
        { path: "offsets.json.gz", filePath: offsetsPath },
        { path: "creator-games.json.gz", filePath: creatorIndexPath },
        { path: "upcoming-games.json.gz", filePath: upcomingIndexPath },
        { path: "catalog-manifest.json", filePath: path.join(docsDir, "catalog-manifest.json") },
      ]);
    } catch (hfErr: any) {
      console.error(`⚠️ Hugging Face upload error: ${hfErr.message}`);
      console.log("   (catalog.raw is generated in dist-hf/ and can be uploaded via huggingface-cli)");
    }
  } else {
    console.warn("⚠️ No HF_TOKEN provided — skipping Hugging Face dataset upload step.");
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("\n==========================================================");
  console.log(`🎉 CATALOG SYNC COMPLETE in ${durationSec}s!`);
  console.log(`   Total Games: ${catalog.length.toLocaleString()}`);
  console.log(`   New Games Appended: ${appendedCount}`);
  console.log(`   catalog.raw: ${(currentRawSize / (1024 * 1024)).toFixed(2)} MB`);
  console.log("==========================================================\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
