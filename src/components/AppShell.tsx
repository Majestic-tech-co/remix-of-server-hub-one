import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { LogOut, Server, Activity, LayoutDashboard, Play, UserCog, ScrollText, Users } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AlertsBell } from "@/components/AlertsBell";
import { WorkspaceSwitcher } from "@/components/WorkspaceSwitcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import type { ReactNode } from "react";

const items = [
  { title: "Overview", url: "/overview", icon: LayoutDashboard },
  { title: "Servers", url: "/", icon: Server, exact: true },
  { title: "Automation", url: "/automation", icon: Play },
  { title: "Activity", url: "/activity", icon: ScrollText },
  { title: "Team", url: "/team", icon: Users },
  { title: "Account", url: "/account", icon: UserCog },
];

function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link to="/overview" className="flex items-center gap-2.5 px-2 py-1">
          <div className="btn-glow relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
            <Activity className="h-4 w-4 text-primary-foreground" />
            <span className="status-dot absolute -right-1 -top-1 bg-success text-success" />
          </div>
          <div className="flex flex-col leading-none group-data-[collapsible=icon]:hidden">
            <span className="text-gradient font-display text-base font-bold tracking-[0.14em]">FLEET</span>
            <span className="font-mono text-[10px] text-muted-foreground">control center</span>
          </div>
        </Link>
        <WorkspaceSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => {
                const active = item.exact ? pathname === item.url : pathname.startsWith(item.url);
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton asChild isActive={active} tooltip={item.title}>
                      <Link to={item.url} className="flex items-center gap-2">
                        <item.icon className="h-4 w-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <div className="px-2 pb-1 font-mono text-[10px] text-muted-foreground group-data-[collapsible=icon]:hidden">
          v2.0
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full">
        <AppSidebar />
        <SidebarInset>
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border/50 bg-background/50 px-4 backdrop-blur-2xl">
            <SidebarTrigger />
            <div className="flex items-center gap-3">
              <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
                {user?.email}
              </span>
              <AlertsBell />
              <ThemeToggle />
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  await signOut();
                  navigate({ to: "/auth" });
                }}
              >
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </header>
          <main className="flex-1 p-6 lg:p-8">{children}</main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
