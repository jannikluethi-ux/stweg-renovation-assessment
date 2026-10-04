import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getBranding } from "@/lib/repo";
import { LogoutButton } from "@/components/misc-forms";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LINKS = [
  ["/dashboard", "Dashboard"],
  ["/properties", "Properties"],
  ["/assessments", "Assessments"],
  ["/roadmaps", "Roadmaps"],
  ["/reports", "Reports"],
  ["/documents", "Documents"],
  ["/leads", "Leads"],
  ["/settings", "Settings"],
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const branding = getBranding(user.organizationId);
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar no-print">
        <div className="topbar-inner">
          <div className="brand">
            <small>{branding.companyName}</small>
            <strong>{branding.productName}</strong>
          </div>
          <nav className="primary" aria-label="Primary">
            {LINKS.map(([href, label]) => (
              <Link key={href} href={href}>{label}</Link>
            ))}
          </nav>
          <div className="userbar">
            <span>{user.name} · {user.role === "admin" ? "Administrator" : "Project manager"}</span>
            <LogoutButton />
          </div>
        </div>
      </header>
      <main id="main" className="page">{children}</main>
    </div>
  );
}
