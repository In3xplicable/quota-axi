/**
 * FirstMate's Codex profiles, bindings and metadata snapshot are optional human
 * display sources. Machine quota reports keep their native discovery path.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderQuota, QuotaWindow } from "./types.js";
import { fetchCodexHomeQuota } from "./providers/codex.js";

type Row = Record<string, unknown>;
const PROFILE_ID = /^[A-Za-z0-9._-]+$/;
const HEALTH = new Set([
  "ready",
  "active",
  "cooldown",
  "quota_exhausted",
  "quota_unknown",
  "signed_out",
  "unavailable",
]);

/** FirstMate's explicit configuration directory wins over the home default. */
function configDir(): string {
  return (
    process.env.FIRSTMATE_CONFIG_DIR ||
    process.env.QUOTA_AXI_CONFIG ||
    join(process.env.FM_HOME || join(homedir(), "firstmate"), "config")
  );
}

function readConfig(path: string): Row | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(configDir(), path), "utf8"),
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Row)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Probe each configured profile through Codex's existing profile-only reader.
 * The UI never opens a credential file or retains credentials: only the
 * provider adapter sees the selected home, and each failure stays on its card.
 */
export async function firstmateCodexProfiles(
  probe: (home: string) => Promise<ProviderQuota> = fetchCodexHomeQuota,
): Promise<ProviderQuota[] | undefined> {
  const profiles = readConfig("account-profiles.json");
  const bindings = readConfig("codex-account-bindings.json");
  if (
    profiles?.schema_version !== 1 ||
    !Array.isArray(profiles.profiles) ||
    bindings?.version !== 1 ||
    !bindings.codex_homes ||
    typeof bindings.codex_homes !== "object" ||
    Array.isArray(bindings.codex_homes)
  )
    return undefined;
  const homes = bindings.codex_homes as Row;
  const seen = new Set<string>();
  const selected: { id: string; home: string }[] = [];
  for (const entry of profiles.profiles) {
    if (!entry || typeof entry !== "object") continue;
    const profile = entry as Row;
    const id = profile.profile_name;
    if (
      profile.provider !== "openai" ||
      profile.harness !== "codex" ||
      profile.enabled !== true ||
      typeof id !== "string" ||
      !PROFILE_ID.test(id) ||
      seen.has(id)
    )
      continue;
    seen.add(id);
    if (typeof profile.credential_source_ref !== "string") continue;
    const home = homes[profile.credential_source_ref];
    if (typeof home === "string" && home.startsWith("/") && home.length > 1)
      selected.push({ id, home });
  }
  if (!selected.length) return undefined;
  const reports: ProviderQuota[] = [];
  for (const { id, home } of selected) {
    let report: ProviderQuota;
    try {
      report = await probe(home);
    } catch {
      report = {
        provider: "codex",
        label: "Codex",
        windows: [],
        state: { status: "error", stale: false, error: "quota probe failed" },
      };
    }
    reports.push({
      ...report,
      // Only the configured, validated name is suitable as a display identity.
      accountKey: id,
      accountKeys: [id],
      tuiHealth:
        report.state.status === "auth_required"
          ? "signed out"
          : report.state.status === "fresh"
            ? "ready"
            : report.state.status === "unavailable"
              ? "unavailable"
              : "quota probe failed",
    } as ProviderQuota);
  }
  return reports;
}

function percentage(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
    ? value
    : undefined;
}

function reset(value: unknown): string | undefined {
  return typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    /(?:Z|[+-]\d\d:\d\d)$/.test(value)
    ? value
    : undefined;
}

function windowFrom(
  row: Row,
  prefix: "session" | "weekly",
): QuotaWindow | undefined {
  const remaining = percentage(row[`${prefix}_percent_remaining`]);
  const resetsAt = reset(row[`${prefix}_resets_at`]);
  if (remaining === undefined && resetsAt === undefined) return undefined;
  return {
    id: prefix === "session" ? "five_hour" : "weekly",
    label: prefix === "session" ? "session" : "week",
    kind: prefix,
    ...(remaining === undefined
      ? {}
      : { percentRemaining: remaining, percentUsed: 100 - remaining }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

/** Undefined means no valid configured snapshot; [] means an empty one. */
export function firstmateCodexAccounts(
  home?: string,
): ProviderQuota[] | undefined {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(
      readFileSync(
        home
          ? join(home, "config", "account-quota.json")
          : join(configDir(), "account-quota.json"),
        "utf8",
      ),
    );
  } catch {
    return undefined;
  }
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const data = snapshot as Row;
  if (
    data.version !== 2 ||
    data.source !== "quota-axi" ||
    !Array.isArray(data.accounts)
  )
    return undefined;

  const accounts = new Map<string, Row>();
  for (const entry of data.accounts) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Row;
    const id = row.profile_id;
    if (
      row.provider !== "openai" ||
      typeof id !== "string" ||
      !PROFILE_ID.test(id) ||
      typeof row.health_status !== "string" ||
      !HEALTH.has(row.health_status)
    )
      continue;
    // One card per profile, even when FirstMate also publishes model-scoped rows.
    if (
      row.model === "all_models" ||
      (!accounts.has(id) && typeof row.model === "string")
    ) {
      accounts.set(id, row);
    }
  }
  return [...accounts].map(([id, row]) => {
    const health = row.health_status as string;
    const windows = [
      windowFrom(row, "session"),
      windowFrom(row, "weekly"),
    ].filter((window): window is QuotaWindow => window !== undefined);
    const fresh =
      health === "ready" ||
      health === "active" ||
      health === "quota_exhausted" ||
      health === "cooldown" ||
      health === "quota_unknown";
    const remaining = percentage(row.quota_remaining);
    const status =
      health === "signed_out"
        ? "auth_required"
        : fresh
          ? "fresh"
          : "unavailable";
    const message =
      health === "quota_exhausted"
        ? "exhausted"
        : health === "quota_unknown"
          ? "quota unknown"
          : health.replace(/_/g, " ");
    return {
      provider: "codex" as const,
      accountKey: id,
      accountKeys: [id],
      label: "Codex",
      windows,
      quotaSemantics: {
        status:
          remaining === undefined ? ("unknown" as const) : ("known" as const),
        effectiveAvailability: [
          {
            scope: "all_models",
            status:
              remaining === undefined
                ? ("unknown" as const)
                : ("known" as const),
            boundedBy: windows.map((window) => window.id),
            ...(remaining === undefined
              ? {}
              : { effectivePercentRemaining: remaining }),
          },
        ],
      },
      state: {
        status,
        stale: false,
        ...(reset(row.observed_at)
          ? { refreshedAt: row.observed_at as string }
          : {}),
        ...(fresh ? {} : { error: message }),
      },
      // TUI-only presentation marker; never sent to JSON/TOON or cache.
      tuiHealth: message,
    } as ProviderQuota;
  });
}
