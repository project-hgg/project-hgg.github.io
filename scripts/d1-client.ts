import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export type Statement = string | { sql: string; args?: any[]; params?: any[] };

export interface D1QueryResult {
  rows: any[];
}

export function escapeSqlValue(val: any): string {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number") return Number.isFinite(val) ? String(val) : "NULL";
  if (typeof val === "boolean") return val ? "1" : "0";
  return `'${String(val).replace(/'/g, "''")}'`;
}

export function interpolateSql(sql: string, params: any[] = []): string {
  let idx = 0;
  return sql.replace(/\?/g, () => {
    if (idx >= params.length) throw new Error("Too few parameters for SQL query");
    return escapeSqlValue(params[idx++]);
  });
}

function resolveLocalWranglerToken(): string | null {
  const candidatePaths = [
    path.join(os.homedir(), "AppData", "Roaming", "xdg.config", ".wrangler", "config", "default.toml"),
    path.join(os.homedir(), ".wrangler", "config", "default.toml"),
    path.join(os.homedir(), ".config", ".wrangler", "config", "default.toml"),
  ];

  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, "utf8");
        const match = content.match(/oauth_token\s*=\s*"([^"]+)"/);
        if (match && match[1]) {
          return match[1];
        }
      }
    } catch {
      // Ignore read errors
    }
  }
  return null;
}

export class D1Client {
  private apiToken: string | null = null;
  private accountId: string;
  private databaseId: string;
  private baseUrl: string;
  private tursoClient: any = null;

  constructor() {
    this.accountId =
      process.env.CLOUDFLARE_ACCOUNT_ID ||
      process.env.CF_ACCOUNT_ID ||
      "6b0657966017fd53f573e6ad8f695f54";

    this.databaseId =
      process.env.CLOUDFLARE_DATABASE_ID ||
      process.env.CLOUDFLARE_D1_DATABASE_ID ||
      process.env.D1_DATABASE_ID ||
      "793cbbd8-84b1-43e7-9644-10071abdef18";

    const envToken =
      process.env.CLOUDFLARE_API_TOKEN ||
      process.env.CF_API_TOKEN ||
      process.env.CLOUDFLARE_D1_TOKEN;

    if (envToken) {
      this.apiToken = envToken;
    } else {
      const localToken = resolveLocalWranglerToken();
      if (localToken) {
        this.apiToken = localToken;
      } else if (!process.env.TURSO_DATABASE_URL) {
        throw new Error(
          "Cloudflare D1 credentials missing. Please set CLOUDFLARE_API_TOKEN environment variable."
        );
      }
    }

    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
  }

  private async getTursoClient() {
    if (!this.tursoClient) {
      const { createClient } = await import("@libsql/client");
      this.tursoClient = createClient({
        url: process.env.TURSO_DATABASE_URL!,
        authToken: process.env.TURSO_AUTH_TOKEN,
      });
    }
    return this.tursoClient;
  }

  private async request(body: any, retries = 3): Promise<any> {
    let lastError: any = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetch(this.baseUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        const data: any = await res.json();
        if (!res.ok || !data.success) {
          const errMsgs = data.errors?.map((e: any) => e.message || JSON.stringify(e)).join(", ");
          throw new Error(`D1 API error (${res.status}): ${errMsgs || res.statusText}`);
        }
        return data;
      } catch (err: any) {
        lastError = err;
        if (attempt < retries) {
          const delay = Math.pow(2, attempt) * 500;
          console.warn(`[D1Client] Retry ${attempt}/${retries} after ${delay}ms: ${err.message}`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  }

  async execute(statement: Statement): Promise<D1QueryResult> {
    if (!this.apiToken && process.env.TURSO_DATABASE_URL) {
      const client = await this.getTursoClient();
      return client.execute(statement);
    }

    let sql: string;
    let params: any[] = [];

    if (typeof statement === "string") {
      sql = statement;
    } else {
      sql = statement.sql;
      params = statement.args || statement.params || [];
    }

    const body: any = { sql };
    if (params.length > 0) {
      body.params = params;
    }

    const data = await this.request(body);
    const firstResult = data.result?.[0];
    return {
      rows: firstResult?.results || [],
    };
  }

  async batch(statements: Statement[], mode: "write" | "read" = "write", chunkSize = 50): Promise<any[]> {
    if (statements.length === 0) return [];

    if (!this.apiToken && process.env.TURSO_DATABASE_URL) {
      const client = await this.getTursoClient();
      return client.batch(statements as any, mode);
    }

    const allResults: any[] = [];

    for (let i = 0; i < statements.length; i += chunkSize) {
      const chunk = statements.slice(i, i + chunkSize);
      const sqlStatements: string[] = [];

      for (const stmt of chunk) {
        if (typeof stmt === "string") {
          let trimmed = stmt.trim();
          if (trimmed.endsWith(";")) trimmed = trimmed.slice(0, -1);
          sqlStatements.push(trimmed);
        } else {
          const params = stmt.args || stmt.params || [];
          let interpolated = params.length > 0 ? interpolateSql(stmt.sql, params) : stmt.sql;
          let trimmed = interpolated.trim();
          if (trimmed.endsWith(";")) trimmed = trimmed.slice(0, -1);
          sqlStatements.push(trimmed);
        }
      }

      const multiSql = sqlStatements.join(";\n") + ";";
      const data = await this.request({ sql: multiSql });
      if (data.result) {
        allResults.push(...data.result);
      }
    }

    return allResults;
  }
}

// Lazy singleton
let instance: D1Client | null = null;
export function getD1Client(): D1Client {
  if (!instance) {
    instance = new D1Client();
  }
  return instance;
}

export const d1Client = {
  execute: (stmt: Statement) => getD1Client().execute(stmt),
  batch: (stmts: Statement[], mode?: "write" | "read") => getD1Client().batch(stmts, mode),
};
