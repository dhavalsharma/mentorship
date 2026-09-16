import { redirect } from "next/navigation";

/**
 * There is no `/auth/me` route to check session state here, so the root
 * page doesn't try — it just points at `/dashboard`, whose layout does the
 * actual "am I logged in" probe (by calling a real data route and reading
 * the 401) and redirects to `/login` itself when that fails.
 */
export default function RootPage() {
  redirect("/dashboard");
}
