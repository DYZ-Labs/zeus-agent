"use server";

import { getAuthConfiguration } from "@/server/auth/config";
import { authDestinationCookie } from "@/server/auth/destination";
import { safeNextPath } from "@/server/auth/paths";
import { createSupabaseServerClient } from "@/server/auth/supabase";
import type { AuthError } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

const AuthIntent = z.enum(["login", "signup"]);
const Email = z.string().trim().toLowerCase().email();

export type AuthActionState = {
  status: "idle" | "sent" | "error";
  message: string;
};

export async function requestEmailLinkAction(
  intentValue: string,
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const intent = AuthIntent.safeParse(intentValue);
  const email = Email.safeParse(formData.get("email"));
  const configuration = getAuthConfiguration();

  if (!intent.success || !email.success) {
    return { status: "error", message: "Enter a valid email address." };
  }
  if (configuration.mode !== "configured") {
    return {
      status: "error",
      message:
        configuration.mode === "misconfigured"
          ? configuration.message
          : "Supabase login is not configured yet.",
    };
  }

  // This public action never inspects the private store. Only the configured owner
  // email can consume the project's email quota or create an Auth user.
  if (email.data !== configuration.ownerEmail) {
    return {
      status: "error",
      message: "Use the owner email configured for this Zeus installation.",
    };
  }

  const next = safeNextPath(String(formData.get("next") ?? "/"));
  const supabase = await createSupabaseServerClient(configuration, {
    cookieWrites: "required",
  });
  const { error } = await supabase.auth.signInWithOtp({
    email: email.data,
    options: {
      shouldCreateUser: intent.data === "signup",
      // Keep this URL exact so it matches Supabase's redirect allow-list. The
      // post-login destination travels in a short-lived HttpOnly cookie instead.
      emailRedirectTo: `${configuration.siteUrl}/auth/confirm`,
    },
  });

  if (error) {
    return {
      status: "error",
      message: emailAuthErrorMessage(error),
    };
  }

  const cookieStore = await cookies();
  cookieStore.set(authDestinationCookie(next, configuration.siteUrl));

  return {
    status: "sent",
    message:
      intent.data === "signup"
        ? "Check your email, then open the newest link in this same browser to finish signup."
        : "Check your email, then open the newest link in this same browser to log in.",
  };
}

export async function startGoogleAuthAction(formData: FormData): Promise<void> {
  const configuration = getAuthConfiguration();
  if (configuration.mode !== "configured") {
    redirect(
      `/auth/login?error=${encodeURIComponent(
        configuration.mode === "misconfigured"
          ? configuration.message
          : "Supabase login is not configured yet.",
      )}`,
    );
  }

  const next = safeNextPath(String(formData.get("next") ?? "/"));
  const supabase = await createSupabaseServerClient(configuration, {
    cookieWrites: "required",
  });
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${configuration.siteUrl}/auth/callback`,
    },
  });

  if (error || !data.url) {
    redirect(
      `/auth/login?error=${encodeURIComponent(
        googleAuthErrorMessage(error),
      )}`,
    );
  }

  const cookieStore = await cookies();
  cookieStore.set(authDestinationCookie(next, configuration.siteUrl));
  redirect(data.url);
}

export async function logoutAction(): Promise<void> {
  const configuration = getAuthConfiguration();
  if (configuration.mode === "configured") {
    const supabase = await createSupabaseServerClient(configuration, {
      cookieWrites: "required",
    });
    await supabase.auth.signOut({ scope: "local" });
  }
  revalidatePath("/", "layout");
  redirect("/");
}

function emailAuthErrorMessage(error: AuthError): string {
  if (error.code === "email_address_not_authorized") {
    return (
      "Supabase's default email service can only send to members of this project's " +
      "organization. Add this email under Organization → Team or configure custom SMTP."
    );
  }
  if (error.status === 429 || error.code?.includes("rate_limit")) {
    return "Too many email attempts. Wait at least 60 seconds and use only the newest link.";
  }
  if (error.message.toLowerCase().includes("signups not allowed")) {
    return "No Zeus account exists for this email yet. Choose Sign up first.";
  }
  return error.message;
}

function googleAuthErrorMessage(error: AuthError | null): string {
  if (
    error?.message.toLowerCase().includes("provider is not enabled") ||
    error?.message.toLowerCase().includes("unsupported provider")
  ) {
    return "Google login is not enabled in Supabase. Enable it under Authentication → Sign In / Providers.";
  }
  return error?.message ?? "Google login could not be started.";
}
