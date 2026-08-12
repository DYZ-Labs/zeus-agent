import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";

import { Nav } from "@/components/nav";
import { listRecentChats } from "@/core/conversations";
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
  description: "A personal agent with a durable memory.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const access = await getOwnerAccess();
  const recentChats = access.canAccessPrivateData ? listRecentChats(access.db) : [];
  const account = access.state === "authorized" ? access.account : null;

  return (
    <html lang="en" className={mono.variable}>
      <body className="h-screen overflow-hidden">
        <div className="flex h-screen w-full flex-col lg:flex-row">
          <Nav
            initialRecentChats={recentChats}
            authMode={authMode(getAuthConfiguration())}
            account={account}
          />
          <main className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</main>
        </div>
      </body>
    </html>
  );
}
