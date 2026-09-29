import AppNavbar from "@/components/AppNavbar";

/** 后台外壳：所有管理页面（route group 不影响 URL） */
export default function AppShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <AppNavbar />
      <main className="app-main">{children}</main>
    </div>
  );
}
