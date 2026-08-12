import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";

import { Nav, type RecentChatDto } from "@/components/nav";
import { AuthModalHost } from "@/components/auth-modal-host";
import { countPendingCandidates } from "@/core/candidates";
import { listRecentChats } from "@/core/conversations";
import { resourceId } from "@/core/resource-id";
import { getOwnerAccess } from "@/server/auth/access";
import { authMode, getAuthConfiguration } from "@/server/auth/config";

import "./globals.css";

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Zeus",
  description:
    "A personal assistant that remembers what matters, helps you follow through, and always shows why.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const access = await getOwnerAccess();
  const recentChats: RecentChatDto[] = access.canAccessPrivateData
    ? listRecentChats(access.db).map((chat) => ({
        id: resourceId("conversation", chat.id),
        title: chat.title,
      }))
    : [];
  const reviewCount = access.canAccessPrivateData ? countPendingCandidates(access.db) : 0;
  const account = access.state === "authorized" ? access.account : null;
  const configuration = getAuthConfiguration();

  return (
    <html lang="en" className={mono.variable}>
      <body className="h-dvh overflow-hidden">
        <div className="flex h-dvh w-full flex-col lg:flex-row">
          <Nav
            initialRecentChats={recentChats}
            authMode={authMode(configuration)}
            account={account}
            reviewCount={reviewCount}
          />
          <main className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</main>
          <AuthModalHost
            authMode={authMode(configuration)}
            canonicalSiteUrl={
              configuration.mode === "configured" ? configuration.siteUrl : null
            }
            blockedAccount={access.canAccessPrivateData ? null : access.account}
          />
        </div>
      </body>
    </html>
  );
}
