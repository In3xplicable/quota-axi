/**
 * FirstMate's metadata-only v2 account snapshot is an optional human display
 * source. It is never used for machine quota reports or credential discovery.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderQuota, QuotaWindow } from "./types.js";

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
  home = process.env.FM_HOME || join(homedir(), "firstmate"),
): ProviderQuota[] | undefined {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(
      readFileSync(join(home, "config", "account-quota.json"), "utf8"),
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
