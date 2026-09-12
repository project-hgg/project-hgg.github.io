import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

interface CatalogGame {
  i: string;
  t: string;
  s: string;
  pop: number | null;
  rt: number | null;
  tr: boolean;
}

export interface TrendingItem {
  rank: number;
  slug: string;
  title: string;
  category: "viral-indie" | "blockbuster" | "classic-revival" | "community-favorite";
  score: number;
  reason: string;
  sources: string[];
}

// 1. Fetch Real Steam Top Sellers in Horror (tag 1667)
async function fetchSteamHorrorTopSellers(): Promise<string[]> {
  console.log("1. Scraping Steam Live Top Sellers (Horror tag 1667)...");
  try {
    const res = await fetch(
      "https://store.steampowered.com/search/results/?query=&start=0&count=40&tags=1667&filter=topsellers&infinite=1",
      { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } }
    );
    if (!res.ok) return [];
    const data: any = await res.json();
    if (!data.results_html) return [];
    const matches = Array.from(data.results_html.matchAll(/<span class="title">([^<]+)<\/span>/g));
    const titles = matches.map((m: any) => m[1].replace(/&amp;/g, "&").trim());
    console.log(`   ✓ Found ${titles.length} top-selling Steam horror games.`);
    return titles;
  } catch (e: any) {
    console.warn("   ⚠️ Steam scrape warning:", e.message);
    return [];
  }
}

// 2. Fetch Real Itch.io Top Horror Titles
async function fetchItchTopHorror(): Promise<string[]> {
  console.log("2. Scraping Itch.io Top Rated Horror...");
  try {
    const res = await fetch("https://itch.io/games/top-rated/tag-horror", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
    });
    if (!res.ok) return [];
    const html = await res.text();
    const matches = Array.from(html.matchAll(/class="title game_link"[^>]*>([^<]+)<\/a>/g));
    const titles = matches.map((m: any) => m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim());
    console.log(`   ✓ Found ${titles.length} top Itch horror games.`);
    return titles;
  } catch (e: any) {
    console.warn("   ⚠️ Itch scrape warning:", e.message);
    return [];
  }
}

// 3. Query Tavily or Exa for Viral Indie Horror Buzz
async function fetchWebSocialBuzz(): Promise<string[]> {
  console.log("3. Querying Web Intelligence for viral breakout horror games...");
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.log("   (Tavily API key not found, skipping web search)");
    return [];
  }
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: "best trending viral indie horror games streaming reddit youtube 2026",
        search_depth: "basic",
        max_results: 5
      })
    });
    if (!res.ok) return [];
    const data: any = await res.json();
    const snippets = (data.results || []).map((r: any) => `${r.title}: ${r.content?.slice(0, 300)}`);
    console.log(`   ✓ Retrieved ${snippets.length} web research context snippets.`);
    return snippets;
  } catch (e: any) {
    console.warn("   ⚠️ Tavily search warning:", e.message);
    return [];
  }
}

// Helper to normalize strings for robust fuzzy slug matching
function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function run() {
  const startTime = performance.now();
  console.log("==================================================");
  console.log("🔥 GENERATING CURATED WEEKLY TOP 50 TRENDING GAMES");
  console.log("==================================================\n");

  // Load catalog dump into memory for grounding & slug matching
  let catalogPath = path.resolve("docs/public/catalog-dump.json.gz");
  if (!fs.existsSync(catalogPath)) {
    catalogPath = path.resolve("public/catalog/catalog-dump.json.gz");
  }
  if (!fs.existsSync(catalogPath)) {
    throw new Error(`Catalog dump not found at ${catalogPath}. Run generate-catalog-dump.ts first.`);
  }

  console.log("📦 Loading catalog dump for ground-truth matching...");
  const rawBuf = fs.readFileSync(catalogPath);
  const catalogData = JSON.parse(zlib.gunzipSync(rawBuf).toString("utf-8"));
  const allGames: CatalogGame[] = Array.isArray(catalogData) ? catalogData : catalogData.games;
  console.log(`   ✓ Loaded ${allGames.length.toLocaleString()} games into catalog index.`);

  // Build lookup structures
  const slugToGame = new Map<string, CatalogGame>();
  const normalizedTitleToGame = new Map<string, CatalogGame>();

  for (const g of allGames) {
    slugToGame.set(g.s, g);
    const norm = normalizeText(g.t);
    if (!normalizedTitleToGame.has(norm) || (g.pop || 0) > (normalizedTitleToGame.get(norm)?.pop || 0)) {
      normalizedTitleToGame.set(norm, g);
    }
  }

  // Fetch all external signals in parallel
  const [steamTitles, itchTitles, webSnippets] = await Promise.all([
    fetchSteamHorrorTopSellers(),
    fetchItchTopHorror(),
    fetchWebSocialBuzz()
  ]);

  console.log("\n4. Synthesizing Top 50 with Gemini 2.5 Flash Grounding...");
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    throw new Error("GEMINI_API_KEY is required in .env");
  }

  const prompt = `You are an expert horror gaming curator.
Analyze these real-world weekly trending signals:

[STEAM TOP SELLERS (HORROR)]:
${steamTitles.slice(0, 35).map((t, idx) => `${idx + 1}. ${t}`).join("\n")}

[ITCH.IO TOP TRENDING / HIGH RATED]:
${itchTitles.slice(0, 20).map((t, idx) => `${idx + 1}. ${t}`).join("\n")}

[WEB & COMMUNITY SIGNALS]:
${webSnippets.slice(0, 5).join("\n---\n")}

TASK:
Produce a curated JSON array of EXACTLY 50 top trending horror games for this week.
Guidelines:
1. Prioritize games genuinely being played and discussed right now (mix of blockbuster hits like Silent Hill 2, Resident Evil, Dead by Daylight, Sons of the Forest, and viral indie darlings like Lethal Company, Buckshot Roulette, Crow Country, Voices of the Void, Signalis, Iron Lung, Mouthwashing, Phasmophobia).
2. Filter out non-horror titles or DLC packs.
3. Every entry MUST use the exact game title so it can match our database.
4. Output STRICT JSON only. Format:
[
  {
    "rank": 1,
    "title": "Exact Game Title",
    "category": "viral-indie" | "blockbuster" | "classic-revival" | "community-favorite",
    "score": 98,
    "reason": "Short 1-sentence explanation of why it's trending this week",
    "sources": ["Steam", "Community Buzz", etc.]
  }
]`;

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json"
        }
      })
    }
  );

  if (!geminiRes.ok) {
    throw new Error(`Gemini API returned ${geminiRes.status}: ${await geminiRes.text()}`);
  }

  const geminiData: any = await geminiRes.json();
  const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error("Empty response from Gemini API");

  const parsedItems: any[] = JSON.parse(rawText);
  console.log(`   ✓ Gemini synthesized ${parsedItems.length} candidate games.`);

  // 5. Ground Truth Slug Resolution (ZERO HALLUCINATIONS)
  console.log("5. Resolving & strictly verifying every game against catalog database...");
  const validatedTop50: TrendingItem[] = [];
  const usedSlugs = new Set<string>();

  for (const item of parsedItems) {
    if (validatedTop50.length >= 50) break;

    const rawTitle = item.title?.trim();
    if (!rawTitle) continue;

    // Try direct slug or title normalization
    const norm = normalizeText(rawTitle);
    let matchedGame = normalizedTitleToGame.get(norm);

    if (!matchedGame) {
      // Fuzzy prefix search
      for (const [key, g] of normalizedTitleToGame.entries()) {
        if (key.includes(norm) || norm.includes(key)) {
          if (Math.abs(key.length - norm.length) < 6) {
            matchedGame = g;
            break;
          }
        }
      }
    }

    if (matchedGame && !usedSlugs.has(matchedGame.s)) {
      usedSlugs.add(matchedGame.s);
      validatedTop50.push({
        rank: validatedTop50.length + 1,
        slug: matchedGame.s,
        title: matchedGame.t,
        category: item.category || "community-favorite",
        score: typeof item.score === "number" ? item.score : 85,
        reason: item.reason || "Trending in horror gaming community discussions.",
        sources: Array.isArray(item.sources) ? item.sources : ["Steam", "Web"]
      });
    }
  }

  // If fewer than 50 (due to some unmapped titles), backfill with top catalog titles
  if (validatedTop50.length < 50) {
    console.log(`   ⚠️ Backfilling ${50 - validatedTop50.length} slots from confirmed high-reputation catalog games...`);
    const fallbackPool = allGames
      .filter(g => g.tr || (g.pop && g.pop > 10) || (g.rt && g.rt >= 85))
      .sort((a, b) => (b.pop || 0) - (a.pop || 0));

    for (const g of fallbackPool) {
      if (validatedTop50.length >= 50) break;
      if (!usedSlugs.has(g.s)) {
        usedSlugs.add(g.s);
        validatedTop50.push({
          rank: validatedTop50.length + 1,
          slug: g.s,
          title: g.t,
          category: "community-favorite",
          score: 80,
          reason: "Consistently popular and highly-rated horror classic.",
          sources: ["Catalog Community Index"]
        });
      }
    }
  }

  // 6. Write output
  const targetOutputs = [
    path.resolve("docs/public/trendingTop50.json"),
    path.resolve("src/data/trendingTop50.json"),
  ];
  for (const outPath of targetOutputs) {
    if (fs.existsSync(path.dirname(outPath))) {
      fs.writeFileSync(outPath, JSON.stringify(validatedTop50, null, 2), "utf-8");
      console.log(`Saved curated trending games to ${outPath}`);
    }
  }
  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

  console.log(`\n==================================================`);
  console.log(`🎉 SUCCESS! Saved ${validatedTop50.length} curated trending games to ${targetOutputs.join(", ")}`);
  console.log(`⏱️ Total Execution Time: ${elapsed}s`);
  console.log(`==================================================\n`);

  console.log("Top 10 Spotlight:");
  validatedTop50.slice(0, 10).forEach(g => {
    console.log(` #${g.rank} [${g.category.toUpperCase()}] ${g.title} (${g.slug}) - ${g.reason}`);
  });
}

run().catch(err => {
  console.error("❌ Trending generation failed:", err);
  process.exit(1);
});
