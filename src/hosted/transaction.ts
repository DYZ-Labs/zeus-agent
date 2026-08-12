import {
  type VerifiedTenantSession,
  verifiedTenantId,
} from "@/hosted/session";

export interface SqlResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount?: number | null;
}

export interface SqlConnection {
  query(sql: string, values?: readonly unknown[]): Promise<SqlResult>;
  release(): void;
}

export interface SqlPool {
  connect(): Promise<SqlConnection>;
}

export interface TenantTransaction {
  query(sql: string, values?: readonly unknown[]): Promise<SqlResult>;
}

export type HostedDatabaseRole = "zeus_app" | "zeus_worker";

const TRANSACTION_CONTROL = /^(?:begin|commit|rollback|savepoint|release|set|reset)\b/iu;
const TENANT_SCOPE_CONTROL = /\b(?:request\.jwt\.claim|set_config\s*\()/iu;
const MULTIPLE_STATEMENTS = /;\s*\S/iu;
const LEADING_SQL_COMMENTS = /^(?:\s+|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/u;

/**
 * Runs all hosted storage work under forced RLS. The tenant comes only from a
 * branded, server-verified session; domain calls cannot supply or switch it.
 */
export class TenantTransactionRunner {
  private readonly role: HostedDatabaseRole;

  constructor(private readonly pool: SqlPool, role: HostedDatabaseRole) {
    if (role !== "zeus_app" && role !== "zeus_worker") {
      throw new Error("Unsupported hosted database role.");
    }
    this.role = role;
  }

  async run<T>(
    session: VerifiedTenantSession,
    operation: (transaction: TenantTransaction) => Promise<T>,
  ): Promise<T> {
    const tenantId = verifiedTenantId(session);
    const connection = await this.pool.connect();
    let active = false;

    try {
      await connection.query("begin");
      active = true;
      const login = await connection.query(
        `select role.rolsuper as is_superuser,
                role.rolbypassrls as bypasses_rls,
                pg_has_role(session_user, $1, 'MEMBER') as can_assume_role
         from pg_roles role where role.rolname = session_user`,
        [this.role],
      );
      const loginRole = login.rows[0];
      if (
        loginRole?.is_superuser !== false ||
        loginRole.bypasses_rls !== false ||
        loginRole.can_assume_role !== true
      ) {
        throw new Error("The hosted database login is not safe for tenant-scoped access.");
      }
      await connection.query(`set local role ${this.role}`);
      await connection.query(
        "select set_config('request.jwt.claim.role', 'authenticated', true)",
      );
      await connection.query(
        "select set_config('request.jwt.claim.sub', $1, true)",
        [tenantId],
      );
      const check = await connection.query(
        "select zeus_private.require_verified_tenant()::text as tenant_id",
      );
      if (check.rows[0]?.tenant_id !== tenantId) {
        throw new Error("The database tenant context could not be established.");
      }

      const transaction: TenantTransaction = Object.freeze({
        query: async (sql: string, values: readonly unknown[] = []) => {
          if (!active) throw new Error("The tenant transaction is no longer active.");
          const inspectedSql = stripLeadingSqlComments(sql);
          if (
            !inspectedSql ||
            TRANSACTION_CONTROL.test(inspectedSql) ||
            TENANT_SCOPE_CONTROL.test(inspectedSql) ||
            MULTIPLE_STATEMENTS.test(inspectedSql)
          ) {
            throw new Error("Domain adapters cannot change transaction or tenant scope.");
          }
          return connection.query(sql, values);
        },
      });

      const result = await operation(transaction);
      await connection.query("commit");
      active = false;
      return result;
    } catch (error) {
      if (active) {
        try {
          await connection.query("rollback");
        } catch {
          // Keep the original domain or database failure.
        }
        active = false;
      }
      throw error;
    } finally {
      connection.release();
    }
  }
}

function stripLeadingSqlComments(sql: string): string {
  let remaining = sql;
  while (true) {
    const stripped = remaining.replace(LEADING_SQL_COMMENTS, "");
    if (stripped === remaining) return stripped.trimStart();
    remaining = stripped;
  }
}
