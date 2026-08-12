export type AuthMode = "local" | "configured" | "misconfigured";

export type AccountSummary = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  provider: string | null;
};
