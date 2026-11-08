-- Run in the Supabase SQL editor.
create extension if not exists btree_gist;

create table profiles (
  id uuid primary key references auth.users on delete cascade,
  name text not null,
  university_id text
);

create table items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles on delete cascade,
  title text not null check (char_length(title) between 1 and 100),
  description text,
  category text not null,
  image_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table borrow_requests (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references items on delete cascade,
  borrower_id uuid not null references profiles on delete cascade,
  period tstzrange not null check (not isempty(period)),
  status text not null default 'pending'
    check (status in ('pending','confirmed','declined','handed_over','returned')),
  handover_pin text,
  return_pin text,
  handed_over_at timestamptz,
  returned_at timestamptz,
  created_at timestamptz not null default now(),
  -- The database itself refuses overlapping confirmed bookings, even under concurrent requests.
  constraint no_double_booking exclude using gist
    (item_id with =, period with &&) where (status in ('confirmed','handed_over'))
);

create index on items (owner_id);
create index on borrow_requests (borrower_id);

-- The Express server connects directly; block anything else from reading tables via the public API.
alter table profiles enable row level security;
alter table items enable row level security;
alter table borrow_requests enable row level security;

-- Part 2 (already ran Part 1? Run only from here down.)
create table messages (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references borrow_requests on delete cascade,
  sender_id uuid not null references profiles on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index on messages (request_id, created_at);

create table reviews (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references borrow_requests on delete cascade,
  reviewer_id uuid not null references profiles on delete cascade,
  rating int not null check (rating between 1 and 5),
  comment text,
  unique (request_id, reviewer_id)
);
alter table messages enable row level security;
alter table reviews enable row level security;

insert into storage.buckets (id, name, public) values ('item-images', 'item-images', true) on conflict do nothing;
create policy "signed-in users upload item images" on storage.objects
  for insert to authenticated with check (bucket_id = 'item-images');

-- Part 3: availability calendar, pickup locations, admin
alter table profiles add column is_admin boolean not null default false;
alter table items add column location text;

create table availability_windows (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references items on delete cascade,
  period tstzrange not null check (not isempty(period) and upper(period) is not null)
);
create index on availability_windows (item_id);
alter table availability_windows enable row level security;

-- An item with no windows is open any time; otherwise the request must fit inside the owner's windows.
create function item_open(i uuid, p tstzrange) returns boolean language sql stable as $$
  select not exists (select 1 from availability_windows where item_id = i)
      or coalesce((select range_agg(period) from availability_windows where item_id = i) @> p, false)
$$;

-- Part 4: instant updates (Supabase Realtime)
-- Notifications are written by triggers, so every state change is announced exactly once.
create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles on delete cascade,
  request_id uuid references borrow_requests on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);
create index on notifications (user_id, created_at desc);
alter table notifications enable row level security;
create policy "read own notifications" on notifications for select to authenticated using (user_id = auth.uid());
-- Messages hold no secrets, so participants may read them directly (this is what Realtime streams).
create policy "participants read messages" on messages for select to authenticated using (
  exists (select 1 from borrow_requests r join items i on i.id = r.item_id
          where r.id = messages.request_id and (r.borrower_id = auth.uid() or i.owner_id = auth.uid())));

create function notify_request() returns trigger language plpgsql security definer set search_path = public as $$
declare t text; o uuid;
begin
  select title, owner_id into t, o from items where id = new.item_id;
  if tg_op = 'INSERT' then
    insert into notifications (user_id, request_id, body) values (o, new.id, 'New request for ' || t);
  elsif new.status is distinct from old.status then
    insert into notifications (user_id, request_id, body)
    values (new.borrower_id, new.id, initcap(replace(new.status, '_', ' ')) || ': ' || t);
  end if;
  return new;
end $$;
create trigger request_events after insert or update on borrow_requests for each row execute function notify_request();

create function notify_message() returns trigger language plpgsql security definer set search_path = public as $$
declare t text; b uuid; o uuid;
begin
  select i.title, r.borrower_id, i.owner_id into t, b, o
  from borrow_requests r join items i on i.id = r.item_id where r.id = new.request_id;
  insert into notifications (user_id, request_id, body)
  values (case when new.sender_id = b then o else b end, new.request_id, 'New message about ' || t);
  return new;
end $$;
create trigger message_events after insert on messages for each row execute function notify_message();

alter publication supabase_realtime add table notifications, messages;

-- Part 5: security hardening and request lifecycle
alter table borrow_requests add column pin_attempts int not null default 0, add column need_id uuid;
alter table borrow_requests drop constraint borrow_requests_status_check,
  add constraint borrow_requests_status_check
  check (status in ('pending','confirmed','declined','handed_over','returned','cancelled'));

-- When one owner approves a "Need It Now" request, the sibling requests are cancelled.
create function cancel_need_siblings() returns trigger language plpgsql as $$
begin
  update borrow_requests set status = 'cancelled'
  where need_id = new.need_id and id <> new.id and status = 'pending';
  return null;
end $$;
create trigger need_siblings after update of status on borrow_requests
  for each row when (new.status = 'confirmed' and new.need_id is not null) execute function cancel_need_siblings();

-- Uploads: own folder only, images only, 2 MB max.
drop policy "signed-in users upload item images" on storage.objects;
create policy "upload to your own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'item-images' and (storage.foldername(name))[1] = auth.uid()::text);
update storage.buckets set file_size_limit = 2097152,
  allowed_mime_types = array['image/jpeg','image/png','image/webp'] where id = 'item-images';
