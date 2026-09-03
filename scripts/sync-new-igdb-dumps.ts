import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as crypto from "crypto";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { createClient } from "@libsql/client";

interface SearchRecord {
  i: string;
  t: string;
  s: string;
  c?: string | null;
  d?: string[] | string | null;
}

interface GameCandidate {
  id: number;
  name: string;
  slug: string;
  summary: string | null;
  storyline: string | null;
  firstReleaseDate: number | null;
  totalRating: number | null;
  follows: number | null;
  coverId: number | null;
  involvedCompanyIds: number[];
  platformIds: number[];
  genreIds: number[];
  websiteIds: number[];
}

function generateId(): string {
  return "c" + Date.now().toString(36) + crypto.randomBytes(8).toString("hex");
}

function normalizeTitle(title: string): string {
  return (title || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\[.*?\]/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function buildHeaderIndexMap(headerLine: string): Map<string, number> {
  const headers = parseCsvLine(headerLine);
  const indexMap = new Map<string, number>();
  headers.forEach((h, idx) => indexMap.set(h.trim(), idx));
  return indexMap;
}

function extractNumbers(field: string): number[] {
  if (!field) return [];
  const matches = field.match(/\d+/g);
  if (!matches) return [];
  return matches.map((n) => parseInt(n, 10));
}

async function streamCsv(filePath: string, onRow: (getField: (name: string) => string) => void): Promise<void> {
  const fileStream = fs.createReadStream(filePath);
  const rlStream = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let headerIndexMap: Map<string, number> | null = null;

  for await (const line of rlStream) {
    if (!line.trim()) continue;
    if (!headerIndexMap) {
      headerIndexMap = buildHeaderIndexMap(line);
      continue;
    }
    const cells = parseCsvLine(line);
    const getField = (fieldName: string): string => {
      const idx = headerIndexMap!.get(fieldName);
      if (idx === undefined || idx >= cells.length) return "";
      return cells[idx];
    };
    onRow(getField);
  }
}

async function getTwitchToken(clientId: string, clientSecret: string): Promise<string> {
  const body = `client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`;
  const resp = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!resp.ok) {
    throw new Error(`Twitch auth failed: ${resp.status} ${await resp.text()}`);
  }
  const data = (await resp.json()) as { access_token: string };
  return data.access_token;
}

async function getDumpDownloadUrl(endpoint: string, clientId: string, token: string): Promise<{ url: string; fileName: string; sizeBytes: number }> {
  const resp = await fetch(`https://api.igdb.com/v4/dumps/${endpoint}`, {
    method: "GET",
    headers: {
      "Client-ID": clientId,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!resp.ok) {
    throw new Error(`IGDB dump info failed for ${endpoint}: ${resp.status} ${await resp.text()}`);
  }

  const data = (await resp.json()) as { s3_url?: string; file_name: string; size_bytes: number };
  if (!data.s3_url) {
    throw new Error(`No S3 URL returned for dump: ${endpoint}`);
  }

  return { url: data.s3_url, fileName: data.file_name, sizeBytes: data.size_bytes };
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  if (!resp.body) throw new Error("No response body");

  await pipeline(Readable.fromWeb(resp.body as any), fs.createWriteStream(destPath));
}

async function main() {
  const isDryRun = process.argv.includes("--dry-run");
  const limitArgIdx = process.argv.indexOf("--limit");
  const maxLimit = limitArgIdx !== -1 ? parseInt(process.argv[limitArgIdx + 1], 10) : Infinity;

  console.log(`🎮 [IGDB Partner Ingestion] Starting weekly horror discovery (Dry Run: ${isDryRun})...`);

  // 1. Verify Credentials
  const twitchClientId = process.env.TWITCH_CLIENT_ID;
  const twitchClientSecret = process.env.TWITCH_CLIENT_SECRET;
  const dbUrl = process.env.TURSO_DATABASE_URL;
  const dbToken = process.env.TURSO_AUTH_TOKEN;

  if (!twitchClientId || !twitchClientSecret) {
    console.error("❌ Missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET environment variable.");
    process.exit(1);
  }

  if (!isDryRun && !dbUrl) {
    console.error("❌ Missing TURSO_DATABASE_URL environment variable.");
    process.exit(1);
  }

  // 2. Resolve Search Index (Zero Turso Reads Diffs)
  let indexPath = path.join(process.cwd(), "docs", "public", "search-index.json");
  if (!fs.existsSync(indexPath)) {
    indexPath = path.join(process.cwd(), "public", "search-index.json");
  }
  if (!fs.existsSync(indexPath)) {
    console.error(`❌ search-index.json not found at: ${indexPath}`);
    process.exit(1);
  }

  console.log("📂 Loading local search index to build deduplication index...");
  const catalog: SearchRecord[] = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  console.log(`📦 Loaded ${catalog.length} existing games from search-index.json.`);

  const existingSlugs = new Set<string>();
  const existingNormTitles = new Set<string>();
  const existingIds = new Set<string>();

  for (const g of catalog) {
    if (g.s) existingSlugs.add(g.s.toLowerCase());
    if (g.i) existingIds.add(g.i);
    const n = normalizeTitle(g.t);
    if (n) existingNormTitles.add(n);
  }

  // 3. Authenticate with Twitch & IGDB Partner Dumps API
  console.log("🔑 Authenticating with Twitch OAuth...");
  const token = await getTwitchToken(twitchClientId, twitchClientSecret);
  console.log("✅ Authenticated successfully!");

  const tempDir = path.join(process.cwd(), ".igdb-temp-dumps");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  try {
    // 4. Download Games Dump
    console.log("📡 Fetching latest signed download URL for 'games' dump...");
    const gamesDumpInfo = await getDumpDownloadUrl("games", twitchClientId, token);
    const gamesCsvPath = path.join(tempDir, gamesDumpInfo.fileName);

    console.log(`⬇️ Downloading ${gamesDumpInfo.fileName} (${(gamesDumpInfo.sizeBytes / 1024 / 1024).toFixed(1)} MB)...`);
    await downloadFile(gamesDumpInfo.url, gamesCsvPath);
    console.log("✅ Games dump downloaded!");

    // 5. Stream Games & Filter for Horror (Theme 19)
    console.log("🔍 Streaming games dump and diffing horror candidates against catalog...");
    const candidateGames: GameCandidate[] = [];
    const neededCoverIds = new Set<number>();
    const neededInvolvedCompanyIds = new Set<number>();
    const neededPlatformIds = new Set<number>();
    const neededWebsiteIds = new Set<number>();

    let totalChecked = 0;
    let horrorFound = 0;

    await streamCsv(gamesCsvPath, (getField) => {
      totalChecked++;
      const themes = extractNumbers(getField("themes"));
      // Theme 19 is Horror in IGDB
      if (!themes.includes(19)) return;

      horrorFound++;
      const id = parseInt(getField("id"), 10);
      const name = getField("name").trim();
      const slug = (getField("slug") || name.toLowerCase().replace(/[^a-z0-9]+/g, "-")).toLowerCase();

      // Deduplication checks against in-repo catalog (Zero Turso Reads!)
      if (existingSlugs.has(slug)) return;
      const norm = normalizeTitle(name);
      if (norm && existingNormTitles.has(norm)) return;

      const coverId = parseInt(getField("cover"), 10);
      const involvedCompanyIds = extractNumbers(getField("involved_companies"));
      const platformIds = extractNumbers(getField("platforms"));
      const genreIds = extractNumbers(getField("genres"));
      const websiteIds = extractNumbers(getField("websites"));

      candidateGames.push({
        id,
        name,
        slug,
        summary: getField("summary") || null,
        storyline: getField("storyline") || null,
        firstReleaseDate: parseInt(getField("first_release_date"), 10) || null,
        totalRating: parseFloat(getField("total_rating")) || null,
        follows: parseInt(getField("follows"), 10) || null,
        coverId: !isNaN(coverId) ? coverId : null,
        involvedCompanyIds,
        platformIds,
        genreIds,
        websiteIds,
      });

      if (!isNaN(coverId)) neededCoverIds.add(coverId);
      involvedCompanyIds.forEach((c) => neededInvolvedCompanyIds.add(c));
      platformIds.forEach((p) => neededPlatformIds.add(p));
      websiteIds.forEach((w) => neededWebsiteIds.add(w));

      if (candidateGames.length >= maxLimit) return;
    });

    console.log(`📊 Scanned ${totalChecked.toLocaleString()} games in dump. Found ${horrorFound.toLocaleString()} total horror titles.`);
    console.log(`🎯 Identified ${candidateGames.length} brand new horror games not in Gamegata!`);

    if (candidateGames.length === 0) {
      console.log("✨ All horror games from the IGDB dump are already in the catalog. Zero writes needed!");
      return;
    }

    // 6. Download Relational Dumps needed ONLY for the candidate games
    console.log("\n📦 Downloading relation dumps for new games enrichment...");

    // 6.1 Covers
    const coversMap = new Map<number, string>();
    if (neededCoverIds.size > 0) {
      console.log("  📸 Downloading covers dump...");
      const coversInfo = await getDumpDownloadUrl("covers", twitchClientId, token);
      const coversPath = path.join(tempDir, coversInfo.fileName);
      await downloadFile(coversInfo.url, coversPath);

      console.log("  🔍 Resolving cover URLs...");
      await streamCsv(coversPath, (getField) => {
        const cId = parseInt(getField("id"), 10);
        if (neededCoverIds.has(cId)) {
          const rawUrl = getField("url");
          const fullUrl = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
          coversMap.set(cId, fullUrl.replace("t_thumb", "t_cover_big"));
        }
      });
    }

    // 6.2 Companies & Involved Companies
    const companyIdToName = new Map<number, string>();
    const involvedCompanyToCompanyId = new Map<number, { companyId: number; isDeveloper: boolean }>();

    if (neededInvolvedCompanyIds.size > 0) {
      console.log("  🏢 Downloading involved_companies dump...");
      const invInfo = await getDumpDownloadUrl("involved_companies", twitchClientId, token);
      const invPath = path.join(tempDir, invInfo.fileName);
      await downloadFile(invInfo.url, invPath);

      const neededCompanyIds = new Set<number>();
      await streamCsv(invPath, (getField) => {
        const icId = parseInt(getField("id"), 10);
        if (neededInvolvedCompanyIds.has(icId)) {
          const companyId = parseInt(getField("company"), 10);
          const isDev = getField("developer") === "true" || getField("developer") === "1";
          involvedCompanyToCompanyId.set(icId, { companyId, isDeveloper: isDev });
          neededCompanyIds.add(companyId);
        }
      });

      console.log("  🏢 Downloading companies dump...");
      const compInfo = await getDumpDownloadUrl("companies", twitchClientId, token);
      const compPath = path.join(tempDir, compInfo.fileName);
      await downloadFile(compInfo.url, compPath);

      await streamCsv(compPath, (getField) => {
        const compId = parseInt(getField("id"), 10);
        if (neededCompanyIds.has(compId)) {
          companyIdToName.set(compId, getField("name").trim());
        }
      });
    }

    // 6.3 Platforms
    const platformsMap = new Map<number, string>();
    if (neededPlatformIds.size > 0) {
      console.log("  🎮 Downloading platforms dump...");
      const platInfo = await getDumpDownloadUrl("platforms", twitchClientId, token);
      const platPath = path.join(tempDir, platInfo.fileName);
      await downloadFile(platInfo.url, platPath);

      await streamCsv(platPath, (getField) => {
        const pId = parseInt(getField("id"), 10);
        if (neededPlatformIds.has(pId)) {
          platformsMap.set(pId, getField("name").trim());
        }
      });
    }

    // 6.4 Websites (Store Links)
    const websitesMap = new Map<number, { store: string; url: string }>();
    if (neededWebsiteIds.size > 0) {
      console.log("  🌐 Downloading websites dump...");
      const webInfo = await getDumpDownloadUrl("websites", twitchClientId, token);
      const webPath = path.join(tempDir, webInfo.fileName);
      await downloadFile(webInfo.url, webPath);

      await streamCsv(webPath, (getField) => {
        const wId = parseInt(getField("id"), 10);
        if (neededWebsiteIds.has(wId)) {
          const category = parseInt(getField("category"), 10);
          const url = getField("url").trim();
          let store = "";
          if (category === 13) store = "Steam";
          else if (category === 14) store = "GOG";
          else if (category === 16) store = "Epic Games Store";
          else if (category === 17) store = "Itch.io";

          if (store && url) {
            websitesMap.set(wId, { store, url });
          }
        }
      });
    }

    // 7. Assemble Games for Ingestion
    console.log("\n🔨 Assembling validated horror game records...");
    const gamesToInsert: any[] = [];
    const now = Date.now();

    for (const g of candidateGames) {
      const gameId = generateId();
      const coverUrl = g.coverId ? coversMap.get(g.coverId) || null : null;

      // Developers
      const devNames: string[] = [];
      for (const icId of g.involvedCompanyIds) {
        const ic = involvedCompanyToCompanyId.get(icId);
        if (ic && ic.isDeveloper) {
          const cName = companyIdToName.get(ic.companyId);
          if (cName && !devNames.includes(cName)) devNames.push(cName);
        }
      }
      const developerNames = devNames.join(", ") || "Independent Creator";

      // Platforms
      const platNames = g.platformIds.map((pId) => platformsMap.get(pId)).filter((x): x is string => !!x);
      const platformNames = platNames.join(", ") || "PC";

      // Purchase Links
      const purchaseLinks: { store: string; url: string }[] = [];
      for (const wId of g.websiteIds) {
        const w = websitesMap.get(wId);
        if (w) purchaseLinks.push(w);
      }

      const releaseDate = g.firstReleaseDate ? new Date(g.firstReleaseDate * 1000).toISOString() : null;
      const status = g.firstReleaseDate && g.firstReleaseDate * 1000 > now ? "upcoming" : "released";

      gamesToInsert.push({
        id: gameId,
        igdbId: g.id,
        title: g.name,
        slug: g.slug,
        summary: g.summary,
        storyline: g.storyline,
        coverUrl,
        rating: g.totalRating,
        popularity: g.follows,
        developerNames,
        genreNames: "Horror",
        platformNames,
        releaseDate,
        status,
        purchaseLinks,
        primaryDeveloper: devNames[0] || "Independent Creator",
      });

      console.log(`  ➕ Prepared: "${g.name}" [Dev: ${developerNames}] [Cover: ${coverUrl ? "YES" : "NO"}] [Links: ${purchaseLinks.length}]`);
    }

    if (isDryRun) {
      console.log(`\n🧪 [DRY-RUN] Prepared ${gamesToInsert.length} games. Skipping database batch execution.`);
      return;
    }

    // 8. Single Batched Write into TursoDB
    console.log(`\n⚡ Committing ${gamesToInsert.length} games to TursoDB in a single batch transaction...`);
    const client = createClient({ url: dbUrl!, authToken: dbToken });
    const batchStatements: any[] = [];

    for (const g of gamesToInsert) {
      // 1. Game row
      batchStatements.push({
        sql: `INSERT INTO "Game" (
          id, igdbId, title, slug, summary, storyline, coverUrl, rating, popularity,
          developerNames, genreNames, platformNames, status, source, isTrending, likesCount, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'igdb', 0, 0, ?, ?)
        ON CONFLICT DO NOTHING`,
        args: [
          g.id,
          g.igdbId,
          g.title,
          g.slug,
          g.summary,
          g.storyline,
          g.coverUrl,
          g.rating,
          g.popularity,
          g.developerNames,
          g.genreNames,
          g.platformNames,
          g.status,
          now,
          now,
        ],
      });

      // 2. PurchaseLink rows
      for (const pl of g.purchaseLinks) {
        const linkHash = crypto.createHash("md5").update(pl.url.toLowerCase()).digest("hex").slice(0, 16);
        batchStatements.push({
          sql: `INSERT INTO "PurchaseLink" (id, storeName, url, gameId) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          args: [`pl_${linkHash}`, pl.store, pl.url, g.id],
        });
      }
    }

    await client.batch(batchStatements, "write");
    console.log(`💾 Successfully committed batch transaction (${batchStatements.length} operations) to TursoDB!`);

    // 9. Append to search-index.json
    console.log("📝 Appending new games to search-index.json...");
    for (const g of gamesToInsert) {
      catalog.push({
        i: g.id,
        t: g.title,
        s: g.slug,
        c: g.coverUrl,
        d: [g.primaryDeveloper],
      });
    }

    fs.writeFileSync(indexPath, JSON.stringify(catalog), "utf-8");
    console.log(`✅ search-index.json updated. Total catalog entries: ${catalog.length}.`);

    // Sync to peer repository if running locally
    const otherPath = indexPath.includes("project-hgg")
      ? path.join("c:", "Users", "bapum", "Desktop", "Portfolio", "gamegata-astro", "public", "search-index.json")
      : path.join("c:", "Users", "bapum", "Desktop", "Portfolio", "project-hgg.github.io", "docs", "public", "search-index.json");

    if (fs.existsSync(path.dirname(otherPath))) {
      try {
        fs.copyFileSync(indexPath, otherPath);
        console.log("✅ Synced updated index to peer repository!");
      } catch {}
    }

    console.log("🎉 IGDB horror ingestion completed successfully!");
  } finally {
    // 10. Clean up temporary dump files to conserve disk space
    try {
      if (fs.existsSync(tempDir)) {
        console.log("🧹 Cleaning up temporary dump files...");
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log("✅ Cleanup complete.");
      }
    } catch {}
  }
}

main().catch((err) => {
  console.error("Fatal IGDB ingestion error:", err);
  process.exit(1);
});
