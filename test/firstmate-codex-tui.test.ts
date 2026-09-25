import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quotaCommand } from "../src/commands.js";
import { firstmateCodexAccounts } from "../src/firstmate-codex-snapshot.js";
import { renderQuotaTui } from "../src/tui.js";
import type { QuotaAxiResponse } from "../src/types.js";

const homes: string[] = [];
const previousHome = process.env.FM_HOME;
const previousFixture = process.env.QUOTA_AXI_SNAPSHOT;

afterEach(() => {
  if (previousHome === undefined) delete process.env.FM_HOME;
  else process.env.FM_HOME = previousHome;
  if (previousFixture === undefined) delete process.env.QUOTA_AXI_SNAPSHOT;
  else process.env.QUOTA_AXI_SNAPSHOT = previousFixture;
  process.exitCode = undefined;
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "quota-axi-firstmate-"));
  homes.push(root);
  mkdirSync(join(root, "config"));
  process.env.FM_HOME = root;
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
