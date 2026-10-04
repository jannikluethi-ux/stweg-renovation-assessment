import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { LoginForm } from "@/components/misc-forms";

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/dashboard");
  return (
    <main className="page" style={{ maxWidth: 480 }}>
      <p className="muted">STWEG &amp; Property Project Office</p>
      <h1>STWEG Renovation Assessment</h1>
      <p className="lede">Sign in to the project office. Demo accounts are listed in the README and are not client credentials.</p>
      <LoginForm />
    </main>
  );
}
