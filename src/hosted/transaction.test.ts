import { describe, expect, it } from "vitest";

import { requireVerifiedTenantSession } from "@/hosted/session";
import {
  type SqlConnection,
  type SqlResult,
  TenantTransactionRunner,
} from "@/hosted/transaction";

const TENANT_ID = "00000000-0000-4000-8000-00000000a001";

class FakeConnection implements SqlConnection {
  readonly calls: { sql: string; values: readonly unknown[] }[] = [];
  released = false;
  tenantId: string | null = null;

  async query(sql: string, values: readonly unknown[] = []): Promise<SqlResult> {
    this.calls.push({ sql, values });
    if (sql.includes("request.jwt.claim.sub")) {
      this.tenantId = String(values[0]);
    }
    if (sql.includes("require_verified_tenant")) {
      return { rows: [{ tenant_id: this.tenantId }] };
    }
    if (sql.includes("rolsuper")) {
      return {
        rows: [{ is_superuser: false, bypasses_rls: false, can_assume_role: true }],
      };
    }
    return { rows: [], rowCount: 0 };
  }

  release(): void {
    this.released = true;
  }
}

async function verifiedSession() {
  return requireVerifiedTenantSession({
    getUser: async () => ({
      data: { user: { id: TENANT_ID } },
      error: null,
    }),
  });
}

describe("TenantTransactionRunner", () => {
  it("sets one verified tenant before domain SQL and commits", async () => {
    const connection = new FakeConnection();
    const runner = new TenantTransactionRunner(
      { connect: async () => connection },
      "zeus_app",
    );

    const result = await runner.run(await verifiedSession(), async (transaction) => {
      await transaction.query("select id from zeus.conversation where id = $1", ["chat-id"]);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(connection.calls.map((call) => call.sql)).toEqual([
      "begin",
      `select role.rolsuper as is_superuser,
                role.rolbypassrls as bypasses_rls,
                pg_has_role(session_user, $1, 'MEMBER') as can_assume_role
         from pg_roles role where role.rolname = session_user`,
      "set local role zeus_app",
      "select set_config('request.jwt.claim.role', 'authenticated', true)",
      "select set_config('request.jwt.claim.sub', $1, true)",
      "select zeus_private.require_verified_tenant()::text as tenant_id",
      "select id from zeus.conversation where id = $1",
      "commit",
    ]);
    expect(connection.calls[4]?.values).toEqual([TENANT_ID]);
    expect(connection.released).toBe(true);
  });

  it("rolls back and releases after a domain failure", async () => {
    const connection = new FakeConnection();
    const runner = new TenantTransactionRunner(
      { connect: async () => connection },
      "zeus_worker",
    );

    await expect(
      runner.run(await verifiedSession(), async () => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");

    expect(connection.calls.map((call) => call.sql)).toContain("rollback");
    expect(connection.calls.map((call) => call.sql)).not.toContain("commit");
    expect(connection.released).toBe(true);
  });

  it("does not let a domain adapter switch transaction or tenant scope", async () => {
    const connection = new FakeConnection();
    const runner = new TenantTransactionRunner(
      { connect: async () => connection },
      "zeus_app",
    );

    await expect(
      runner.run(await verifiedSession(), async (transaction) => {
        await transaction.query("set local request.jwt.claim.sub = 'forged'");
      }),
    ).rejects.toThrow("cannot change transaction or tenant scope");

    expect(connection.calls.map((call) => call.sql)).toContain("rollback");
  });

  it("blocks tenant GUC changes hidden inside a select", async () => {
    const connection = new FakeConnection();
    const runner = new TenantTransactionRunner(
      { connect: async () => connection },
      "zeus_app",
    );

    await expect(
      runner.run(await verifiedSession(), async (transaction) => {
        await transaction.query(
          "select set_config('request.jwt.claim.sub', 'forged', true)",
        );
      }),
    ).rejects.toThrow("cannot change transaction or tenant scope");
  });

  it("blocks transaction control hidden behind SQL comments", async () => {
    const connection = new FakeConnection();
    const runner = new TenantTransactionRunner(
      { connect: async () => connection },
      "zeus_app",
    );

    await expect(
      runner.run(await verifiedSession(), async (transaction) => {
        await transaction.query("/* harmless-looking */ -- more\n commit");
      }),
    ).rejects.toThrow("cannot change transaction or tenant scope");
  });

  it("rejects a superuser or RLS-bypassing login before assuming the app role", async () => {
    class UnsafeConnection extends FakeConnection {
      override async query(
        sql: string,
        values: readonly unknown[] = [],
      ): Promise<SqlResult> {
        const result = await super.query(sql, values);
        return sql.includes("rolsuper")
          ? { rows: [{ is_superuser: true, bypasses_rls: true, can_assume_role: true }] }
          : result;
      }
    }
    const connection = new UnsafeConnection();
    const runner = new TenantTransactionRunner(
      { connect: async () => connection },
      "zeus_app",
    );

    await expect(runner.run(await verifiedSession(), async () => undefined))
      .rejects.toThrow("not safe for tenant-scoped access");
    expect(connection.calls.map((call) => call.sql)).not.toContain("set local role zeus_app");
    expect(connection.calls.map((call) => call.sql)).toContain("rollback");
  });
});
