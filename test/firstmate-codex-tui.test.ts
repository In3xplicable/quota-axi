import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quotaCommand } from "../src/commands.js";
import {
  firstmateCodexAccounts,
  firstmateCodexProfiles,
} from "../src/firstmate-codex-snapshot.js";
import { renderQuotaTui } from "../src/tui.js";
import type { QuotaAxiResponse } from "../src/types.js";

const homes: string[] = [];
const previousHome = process.env.FM_HOME;
const previousFixture = process.env.QUOTA_AXI_SNAPSHOT;
const previousConfig = process.env.FIRSTMATE_CONFIG_DIR;
const previousQuotaConfig = process.env.QUOTA_AXI_CONFIG;

afterEach(() => {
  if (previousHome === undefined) delete process.env.FM_HOME;
  else process.env.FM_HOME = previousHome;
  if (previousFixture === undefined) delete process.env.QUOTA_AXI_SNAPSHOT;
  else process.env.QUOTA_AXI_SNAPSHOT = previousFixture;
  if (previousConfig === undefined) delete process.env.FIRSTMATE_CONFIG_DIR;
  else process.env.FIRSTMATE_CONFIG_DIR = previousConfig;
  if (previousQuotaConfig === undefined) delete process.env.QUOTA_AXI_CONFIG;
  else process.env.QUOTA_AXI_CONFIG = previousQuotaConfig;
  process.exitCode = undefined;
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "quota-axi-firstmate-"));
  homes.push(root);
  mkdirSync(join(root, "config"));
  process.env.FM_HOME = root;
  delete process.env.FIRSTMATE_CONFIG_DIR;
  delete process.env.QUOTA_AXI_CONFIG;
  process.env.QUOTA_AXI_SNAPSHOT = join(root, "vendor-snapshot.json");
  writeFileSync(
    process.env.QUOTA_AXI_SNAPSHOT,
    JSON.stringify({
      schemaVersion: 3,
      providers: [
        {
          provider: "claude",
          label: "Claude",
          source: "oauth",
          windows: [
            {
              id: "seven_day",
              label: "week",
              kind: "weekly",
              percentRemaining: 70,
              percentUsed: 30,
              resetsAt: "2099-09-28T00:00:00Z",
            },
          ],
          state: {
            status: "fresh",
            stale: false,
            refreshedAt: "2026-09-25T00:00:00Z",
            sourcesTried: ["oauth"],
          },
        },
      ],
    }),
  );
  return root;
}

function publish(root: string, accounts: object[]): void {
  writeFileSync(
    join(root, "config", "account-quota.json"),
    JSON.stringify({
      version: 2,
      source: "quota-axi",
      accounts,
    }),
  );
}

function row(
  profile_id: string,
  health_status = "ready",
  session = 79,
  week = 70,
): object {
  return {
    provider: "openai",
    profile_id,
    model: "all_models",
    health_status,
    quota_remaining: Math.min(session, week),
    session_percent_remaining: session,
    weekly_percent_remaining: week,
    session_resets_at: "2099-09-26T12:00:00Z",
    weekly_resets_at: "2099-09-28T00:00:00Z",
    observed_at: "2026-09-25T00:00:00Z",
  };
}

describe("FirstMate Codex profile cards", () => {
  it("retains a single profile and preserves normal non-Codex providers", async () => {
    const root = home();
    publish(root, [row("codex-personal")]);
    const tui = await quotaCommand(
      ["--tui", "--once", "--provider", "codex,claude"],
      undefined,
    );
    expect(tui).toContain("account codex-personal");
    expect(tui).toContain("79%");
    expect(tui).toContain("70%");
    expect(tui).toContain("ready");
    expect(tui).toContain("● claude");
    expect(tui).not.toContain("2099"); // reset is a countdown, not raw identity data
    expect(tui.match(/account codex-personal/g)).toHaveLength(1);
  });

  it("reads fresh snapshots each time, grouping model rows without collapsing profiles", async () => {
    const root = home();
    publish(root, [
      row("codex-personal"),
      row("codex-work", "active", 35, 48),
      { ...row("codex-work"), model: "model:extra" },
    ]);
    const first = await quotaCommand(
      ["--tui", "--once", "--provider", "codex"],
      undefined,
    );
    expect(first).toContain("account codex-personal");
    expect(first).toContain("account codex-work");
    expect(first).toContain("active");
    expect(first.match(/account codex-work/g)).toHaveLength(1);

    publish(root, [
      row("codex-work", "cooldown", 35, 48),
      row("codex-alt", "quota_exhausted", 0, 0),
      row("codex-signed-out", "signed_out"),
      row("codex-failed-probe", "unavailable"),
      row("codex-unmeasured", "quota_unknown"),
    ]);
    const next = await quotaCommand(
      ["--tui", "--once", "--provider", "codex"],
      undefined,
    );
    for (const id of [
      "work",
      "alt",
      "signed-out",
      "failed-probe",
      "unmeasured",
    ]) {
      expect(next).toContain(`account codex-${id}`);
    }
    expect(next).not.toContain("codex-personal");
    for (const state of [
      "cooldown",
      "exhausted",
      "signed out",
      "unavailable",
      "quota unknown",
    ]) {
      expect(next).toContain(state);
    }
  });

  it("ignores unknown fields and invalid identities without rendering secrets", () => {
    const root = home();
    publish(root, [
      {
        ...row("codex-safe"),
        secret: "SECRET_SENTINEL",
        token: "SECRET_SENTINEL",
      },
      { ...row("bad\u001b[31m"), credential: "SECRET_SENTINEL" },
    ]);
    const accounts = firstmateCodexAccounts();
    expect(accounts).toHaveLength(1);
    const report: QuotaAxiResponse = {
      generatedAt: "2026-09-25T00:00:00Z",
      schemaVersion: 6,
      providers: accounts ?? [],
    };
    expect(renderQuotaTui(report)).toContain("codex-safe");
    expect(JSON.stringify(accounts)).not.toContain("SECRET_SENTINEL");
    expect(renderQuotaTui(report)).not.toContain("SECRET_SENTINEL");
  });

  it("does not change the Codex machine report", async () => {
    const root = home();
    publish(root, [row("codex-personal"), row("codex-work")]);
    const json = JSON.parse(
      await quotaCommand(["--json", "--provider", "codex"], undefined),
    ) as QuotaAxiResponse;
    expect(json.providers).toHaveLength(1);
    expect(json.providers[0].accountKey).not.toBe("codex-personal");
  });
});

function configureProfiles(root: string, ids: string[]): void {
  writeFileSync(
    join(root, "config", "account-profiles.json"),
    JSON.stringify({
      schema_version: 1,
      profiles: ids.map((id) => ({
        profile_name: id,
        provider: "openai",
        harness: "codex",
        credential_source_ref: id,
        enabled: true,
      })),
    }),
  );
  writeFileSync(
    join(root, "config", "codex-account-bindings.json"),
    JSON.stringify({
      version: 1,
      codex_homes: Object.fromEntries(ids.map((id) => [id, join(root, id)])),
    }),
  );
}

describe("FirstMate bound Codex profiles", () => {
  for (const count of [1, 2, 3]) {
    it(`draws ${count} separate profile card(s) and keeps other providers`, async () => {
      const root = home();
      const ids = ["profile-a", "profile-b", "profile-c"].slice(0, count);
      configureProfiles(root, ids);
      const visited: string[] = [];
      const reports = await firstmateCodexProfiles(async (codexHome) => {
        visited.push(codexHome);
        return {
          provider: "codex",
          label: "Codex",
          windows: [
            {
              id: "five_hour",
              label: "session",
              kind: "session",
              percentRemaining: 80,
            },
            {
              id: "weekly",
              label: "week",
              kind: "weekly",
              percentRemaining: 60,
            },
          ],
          state: { status: "fresh", stale: false },
        };
      });
      expect(visited).toEqual(ids.map((id) => join(root, id)));
      expect(reports?.map((report) => report.accountKey)).toEqual(ids);
      const rendered = renderQuotaTui({
        generatedAt: new Date().toISOString(),
        schemaVersion: 6,
        providers: [
          ...(reports ?? []),
          {
            provider: "claude",
            label: "Claude",
            windows: [],
            state: { status: "fresh", stale: false },
          },
        ],
      });
      for (const id of ids)
        expect(rendered.match(new RegExp(`account ${id}`, "g"))).toHaveLength(
          1,
        );
      expect(rendered).toContain("● claude");
      expect(rendered).toContain("80%");
      expect(rendered).toContain("60%");
    });
  }

  it("isolates signed out, unavailable and failing probes and re-reads bindings", async () => {
    const root = home();
    configureProfiles(root, ["profile-a", "profile-b", "profile-c"]);
    const outcomes = await firstmateCodexProfiles(async (codexHome) => {
      if (codexHome.endsWith("profile-c")) throw new Error("SECRET_SENTINEL");
      return {
        provider: "codex",
        label: "Codex",
        windows: [],
        state: {
          status: codexHome.endsWith("profile-a")
            ? "auth_required"
            : "unavailable",
          stale: false,
        },
      };
    });
    expect(outcomes?.map((report) => report.state.status)).toEqual([
      "auth_required",
      "unavailable",
      "error",
    ]);
    expect(JSON.stringify(outcomes)).not.toContain("SECRET_SENTINEL");
    const rendered = renderQuotaTui({
      generatedAt: new Date().toISOString(),
      schemaVersion: 6,
      providers: outcomes ?? [],
    });
    expect(rendered).toContain("signed out");
    expect(rendered).toContain("quota probe failed");
    configureProfiles(root, ["profile-b", "profile-c"]);
    expect(
      (
        await firstmateCodexProfiles(async () => ({
          provider: "codex",
          label: "Codex",
          windows: [],
          state: { status: "unavailable", stale: false },
        }))
      )?.map((report) => report.accountKey),
    ).toEqual(["profile-b", "profile-c"]);
  });

  it("honors the explicit config directory over an unrelated FM_HOME", async () => {
    const root = home();
    process.env.FIRSTMATE_CONFIG_DIR = join(root, "config");
    process.env.FM_HOME = join(root, "unrelated");
    configureProfiles(root, ["profile-a"]);
    expect(
      (
        await firstmateCodexProfiles(async () => ({
          provider: "codex",
          label: "Codex",
          windows: [],
          state: { status: "fresh", stale: false },
        }))
      )?.[0].accountKey,
    ).toBe("profile-a");
  });
});
