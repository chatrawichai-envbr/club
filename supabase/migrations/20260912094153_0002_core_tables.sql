create table if not exists public.settings (
  key         text primary key,
  value       jsonb not null,
  is_public   boolean not null default true,
  description text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null
);

create table if not exists public.org_types (
  code          text primary key,
  name          text not null,
  sort_order    int  not null default 100,
  requires_text boolean not null default false,
  active        boolean not null default true
);

create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null default 'admin'
               check (role in ('superadmin', 'admin', 'registrar', 'treasurer')),
  full_name  text,
  position   text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

comment on column public.admins.role is
  'superadmin=จัดการผู้ดูแล, admin=ทุกอย่างยกเว้นจัดการผู้ดูแล, registrar=ทะเบียนสมาชิก, treasurer=การเงิน/สลิป';

create table if not exists public.members (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null unique references auth.users(id) on delete restrict,
  member_code   text unique,

  title         text,
  title_other   text,
  first_name    text not null,
  last_name     text not null,
  first_name_en text,
  last_name_en  text,

  national_id_enc   bytea,
  national_id_bidx  text unique,
  national_id_last4 text,
  phone_enc         bytea,
  phone_bidx        text,
  addr_detail_enc   bytea,

  birth_date    date,
  gender        text check (gender is null or gender in ('ชาย', 'หญิง', 'ไม่ระบุ')),
  email         text,

  license_no          text,
  license_type        text,
  license_issued_on   date,
  license_expires_on  date,

  education_level text,
  education_major text,

  org_type_code   text references public.org_types(code) on delete set null,
  org_type_other  text,
  org_name        text,
  position_name   text,
  work_tambon     text,
  work_amphoe     text,
  work_province   text default 'บุรีรัมย์',
  work_zip        text,
  work_phone      text,

  addr_tambon   text,
  addr_amphoe   text,
  addr_province text default 'บุรีรัมย์',
  addr_zip      text,

  photo_path     text,
  signature_path text,

  status        text not null default 'pending'
                  check (status in ('pending', 'active', 'expired', 'revoked')),
  member_since  date,
  valid_from    date,
  valid_to      date,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,

  constraint members_org_other_required check (
    org_type_code is distinct from 'other' or nullif(btrim(coalesce(org_type_other, '')), '') is not null
  ),
  constraint members_title_other_required check (
    title is distinct from 'อื่นๆ' or nullif(btrim(coalesce(title_other, '')), '') is not null
  )
);

create index if not exists members_status_idx      on public.members (status);
create index if not exists members_org_type_idx    on public.members (org_type_code);
create index if not exists members_valid_to_idx    on public.members (valid_to);
create index if not exists members_name_idx        on public.members (last_name, first_name);
create index if not exists members_phone_bidx_idx  on public.members (phone_bidx);

create table if not exists public.applications (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references public.members(id) on delete cascade,
  app_no      text unique,
  app_type    text not null default 'new' check (app_type in ('new', 'renew')),
  status      text not null default 'draft'
                check (status in ('draft', 'submitted', 'awaiting_payment',
                                  'payment_submitted', 'payment_verified',
                                  'approved', 'rejected', 'cancelled')),
  fee_amount  numeric(10, 2) not null default 0,
  term_years  int not null default 1,
  period_start date,
  period_end   date,

  submitted_at timestamptz,
  reviewed_at  timestamptz,
  reviewed_by  uuid references auth.users(id) on delete set null,
  review_note  text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists applications_member_idx on public.applications (member_id);
create index if not exists applications_status_idx on public.applications (status);
create index if not exists applications_created_idx on public.applications (created_at desc);

create unique index if not exists applications_one_open_per_member
  on public.applications (member_id)
  where status in ('draft', 'submitted', 'awaiting_payment',
                   'payment_submitted', 'payment_verified');

create table if not exists public.payments (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  member_id      uuid not null references public.members(id) on delete cascade,

  amount     numeric(10, 2) not null,
  paid_at    timestamptz,
  bank_code  text,
  bank_name  text,
  payer_name text,
  ref_no     text,

  slip_path    text,
  slip_sha256  text,
  slip_qr_raw  text,

  check_score  int,
  check_result jsonb,

  status        text not null default 'pending'
                  check (status in ('pending', 'verified', 'rejected', 'duplicate')),
  verified_at   timestamptz,
  verified_by   uuid references auth.users(id) on delete set null,
  reject_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payments_application_idx on public.payments (application_id);
create index if not exists payments_member_idx      on public.payments (member_id);
create index if not exists payments_status_idx      on public.payments (status);

create unique index if not exists payments_slip_hash_uniq
  on public.payments (slip_sha256)
  where slip_sha256 is not null and status <> 'rejected';
create unique index if not exists payments_ref_no_uniq
  on public.payments (ref_no)
  where ref_no is not null and btrim(ref_no) <> '' and status <> 'rejected';

create table if not exists public.receipts (
  id             uuid primary key default gen_random_uuid(),
  receipt_no     text not null unique,
  payment_id     uuid not null unique references public.payments(id) on delete restrict,
  application_id uuid not null references public.applications(id) on delete restrict,
  member_id      uuid not null references public.members(id) on delete restrict,

  amount      numeric(10, 2) not null,
  amount_text text,
  payer_name  text,
  purpose     text,
  issued_at   timestamptz not null default now(),
  issued_by   uuid references auth.users(id) on delete set null,

  created_at timestamptz not null default now()
);

create index if not exists receipts_member_idx on public.receipts (member_id);

create table if not exists public.cards (
  id             uuid primary key default gen_random_uuid(),
  member_id      uuid not null references public.members(id) on delete cascade,
  application_id uuid references public.applications(id) on delete set null,
  card_no        text not null unique,
  verify_token   text not null unique,

  issued_at  timestamptz not null default now(),
  valid_from date not null,
  valid_to   date not null,
  status     text not null default 'active'
               check (status in ('active', 'expired', 'revoked', 'replaced')),

  print_count     int not null default 0,
  last_printed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint cards_period_valid check (valid_to >= valid_from)
);

create index if not exists cards_member_idx on public.cards (member_id);
create index if not exists cards_status_idx on public.cards (status);

create table if not exists public.consents (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  member_id   uuid references public.members(id) on delete cascade,
  doc         text not null,
  version     text not null,
  accepted    boolean not null default true,
  accepted_at timestamptz not null default now(),
  user_agent  text,
  created_at  timestamptz not null default now()
);

create index if not exists consents_user_idx on public.consents (user_id);

create table if not exists public.audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor_id    uuid,
  actor_email text,
  actor_role  text,
  action      text not null,
  entity      text not null,
  entity_id   text,
  entity_label text,
  changed     jsonb,
  note        text,
  user_agent  text
);

create index if not exists audit_log_at_idx     on public.audit_log (at desc);
create index if not exists audit_log_entity_idx on public.audit_log (entity, entity_id);
create index if not exists audit_log_actor_idx  on public.audit_log (actor_id);

drop trigger if exists trg_members_touch on public.members;
create trigger trg_members_touch before update on public.members
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_applications_touch on public.applications;
create trigger trg_applications_touch before update on public.applications
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_payments_touch on public.payments;
create trigger trg_payments_touch before update on public.payments
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_cards_touch on public.cards;
create trigger trg_cards_touch before update on public.cards
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
