import type { VerifiedTenantSession } from "@/hosted/session";
import type { HostedDomainServices } from "@/hosted/services";
import type {
  TenantTransaction,
  TenantTransactionRunner,
} from "@/hosted/transaction";

/**
 * Binds async domain services to one already-scoped SQL transaction. Concrete
 * Postgres adapters are ported domain-by-domain and tested for SQLite parity.
 */
export interface HostedDomainAdapter {
  bind(transaction: TenantTransaction): HostedDomainServices;
}

export class PostgresHostedStore {
  constructor(
    private readonly transactions: TenantTransactionRunner,
    private readonly adapter: HostedDomainAdapter,
  ) {}

  transaction<T>(
    session: VerifiedTenantSession,
    operation: (services: HostedDomainServices) => Promise<T>,
  ): Promise<T> {
    return this.transactions.run(session, async (transaction) =>
      operation(this.adapter.bind(transaction)),
    );
  }
}
