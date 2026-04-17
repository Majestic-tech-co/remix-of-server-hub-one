create table public.servers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  hostname text,
  ip_address text,
  os text,
  tags text[] not null default '{}',
  agent_token text not null unique default encode(gen_random_bytes(24), 'hex'),
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
create index servers_user_id_idx on public.servers(user_id);
alter table public.servers enable row level security;

create policy "owner select servers" on public.servers for select using (auth.uid() = user_id);
create policy "owner insert servers" on public.servers for insert with check (auth.uid() = user_id);
create policy "owner update servers" on public.servers for update using (auth.uid() = user_id);
create policy "owner delete servers" on public.servers for delete using (auth.uid() = user_id);

create table public.metrics (
  id bigserial primary key,
  server_id uuid not null references public.servers(id) on delete cascade,
  recorded_at timestamptz not null default now(),
  cpu_percent numeric,
  memory_percent numeric,
  memory_used_mb numeric,
  memory_total_mb numeric,
  disk_percent numeric,
  disk_used_gb numeric,
  disk_total_gb numeric,
  net_rx_kbs numeric,
  net_tx_kbs numeric,
  load_1 numeric,
  uptime_seconds bigint
);
create index metrics_server_recorded_idx on public.metrics(server_id, recorded_at desc);
alter table public.metrics enable row level security;

create policy "owner select metrics" on public.metrics for select
  using (exists (select 1 from public.servers s where s.id = metrics.server_id and s.user_id = auth.uid()));

create type public.command_status as enum ('pending', 'running', 'completed', 'failed');

create table public.commands (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  command text not null,
  status public.command_status not null default 'pending',
  exit_code integer,
  stdout text,
  stderr text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);
create index commands_server_status_idx on public.commands(server_id, status, created_at);
alter table public.commands enable row level security;

create policy "owner select commands" on public.commands for select using (auth.uid() = user_id);
create policy "owner insert commands" on public.commands for insert
  with check (auth.uid() = user_id and exists (select 1 from public.servers s where s.id = server_id and s.user_id = auth.uid()));
create policy "owner delete commands" on public.commands for delete using (auth.uid() = user_id);