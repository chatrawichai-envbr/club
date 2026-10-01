create or replace function app_private.slip_server_check(
  p_uid        uuid,
  p_fee        numeric,
  p_amount     numeric,
  p_paid_at    timestamptz,
  p_slip_path  text,
  p_slip_sha256 text,
  p_ref        text
) returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'app_private', 'storage', 'pg_temp'
as $function$
declare
  v_cfg       jsonb := app_private.setting('slip_check', '{}'::jsonb);
  v_max_age   int   := coalesce((v_cfg ->> 'max_age_days')::int, 30);
  v_tol       numeric := coalesce((v_cfg ->> 'allow_amount_tolerance')::numeric, 0);
  v_obj       storage.objects;
  v_mime      text;
  v_size      bigint;
  v_allowed   text[];
  v_limit     bigint;
  v_checks    jsonb := '[]'::jsonb;
  v_blockers  text[] := '{}';
  v_total     int := 0;
  v_earned    int := 0;
  v_age_days  numeric;
begin
  select b.allowed_mime_types, b.file_size_limit
    into v_allowed, v_limit
    from storage.buckets b where b.id = 'payment-slips';

  select * into v_obj
    from storage.objects o
   where o.bucket_id = 'payment-slips' and o.name = p_slip_path;

  v_mime := v_obj.metadata ->> 'mimetype';
  v_size := (v_obj.metadata ->> 'size')::bigint;

  if v_obj.name is not null then
    v_checks := v_checks || jsonb_build_object('key','slip_exists',
      'label','พบไฟล์สลิปในที่เก็บไฟล์ของระบบ','pass',true,'weight',20);
    v_total := v_total + 20; v_earned := v_earned + 20;
  else
    v_checks := v_checks || jsonb_build_object('key','slip_exists',
      'label','ไม่พบไฟล์สลิปตามเส้นทางที่ส่งมา','pass',false,'weight',20);
    v_total := v_total + 20;
    v_blockers := array_append(v_blockers, 'slip_exists'::text);
  end if;

  if p_slip_path is not null and split_part(p_slip_path, '/', 1) = p_uid::text then
    v_checks := v_checks || jsonb_build_object('key','slip_owner',
      'label','ไฟล์สลิปอยู่ในโฟลเดอร์ของผู้ส่ง','pass',true,'weight',20);
    v_total := v_total + 20; v_earned := v_earned + 20;
  else
    v_checks := v_checks || jsonb_build_object('key','slip_owner',
      'label','ไฟล์สลิปไม่ได้อยู่ในโฟลเดอร์ของผู้ส่ง','pass',false,'weight',20);
    v_total := v_total + 20;
    v_blockers := array_append(v_blockers, 'slip_owner'::text);
  end if;

  if v_obj.name is null then
    v_checks := v_checks || jsonb_build_object('key','file_type',
      'label','ไม่มีไฟล์ให้ตรวจชนิด','pass',null,'weight',10);
  elsif v_allowed is null or v_mime = any (v_allowed) then
    v_checks := v_checks || jsonb_build_object('key','file_type',
      'label','ชนิดไฟล์ถูกต้อง (' || coalesce(v_mime,'ไม่ทราบ') || ')','pass',true,'weight',10);
    v_total := v_total + 10; v_earned := v_earned + 10;
  else
    v_checks := v_checks || jsonb_build_object('key','file_type',
      'label','ชนิดไฟล์ไม่รองรับ (' || coalesce(v_mime,'ไม่ทราบ') || ')','pass',false,'weight',10);
    v_total := v_total + 10;
    v_blockers := array_append(v_blockers, 'file_type'::text);
  end if;

  if v_obj.name is null then
    v_checks := v_checks || jsonb_build_object('key','file_size',
      'label','ไม่มีไฟล์ให้ตรวจขนาด','pass',null,'weight',10);
  elsif v_size > 2048 and (v_limit is null or v_size <= v_limit) then
    v_checks := v_checks || jsonb_build_object('key','file_size',
      'label','ขนาดไฟล์เหมาะสม (' || round(v_size / 1024.0)::text || ' KB)','pass',true,'weight',10);
    v_total := v_total + 10; v_earned := v_earned + 10;
  else
    v_checks := v_checks || jsonb_build_object('key','file_size',
      'label','ขนาดไฟล์ไม่เหมาะสม (' || round(coalesce(v_size,0) / 1024.0)::text || ' KB)',
      'pass',false,'weight',10);
    v_total := v_total + 10;
    v_blockers := array_append(v_blockers, 'file_size'::text);
  end if;

  if p_fee > 0 and abs(coalesce(p_amount,0) - p_fee) <= v_tol + 0.004 then
    v_checks := v_checks || jsonb_build_object('key','amount_match',
      'label','จำนวนเงินตรงกับค่าธรรมเนียม (' || to_char(p_amount,'FM999999990.00') || ' บาท)',
      'pass',true,'weight',20);
    v_total := v_total + 20; v_earned := v_earned + 20;
  else
    v_checks := v_checks || jsonb_build_object('key','amount_match',
      'label','จำนวนเงินไม่ตรงกับค่าธรรมเนียม (ส่งมา '
        || to_char(coalesce(p_amount,0),'FM999999990.00') || ' บาท ต้องชำระ '
        || to_char(p_fee,'FM999999990.00') || ' บาท)','pass',false,'weight',20);
    v_total := v_total + 20;
    v_blockers := array_append(v_blockers, 'amount_match'::text);
  end if;

  if p_paid_at is null then
    v_checks := v_checks || jsonb_build_object('key','date_valid',
      'label','ไม่ได้ระบุวัน-เวลาที่โอน','pass',false,'weight',15);
    v_total := v_total + 15;
    v_blockers := array_append(v_blockers, 'date_valid'::text);
  else
    v_age_days := extract(epoch from (now() - p_paid_at)) / 86400.0;
    if p_paid_at > now() + interval '5 minutes' then
      v_checks := v_checks || jsonb_build_object('key','date_valid',
        'label','วัน-เวลาที่โอนเป็นเวลาในอนาคต','pass',false,'weight',15);
      v_total := v_total + 15;
      v_blockers := array_append(v_blockers, 'date_valid'::text);
    elsif v_age_days > v_max_age then
      v_checks := v_checks || jsonb_build_object('key','date_valid',
        'label','สลิปเก่าเกิน ' || v_max_age::text || ' วัน (' || floor(v_age_days)::text || ' วัน)',
        'pass',false,'weight',15);
      v_total := v_total + 15;
      v_blockers := array_append(v_blockers, 'date_valid'::text);
    else
      v_checks := v_checks || jsonb_build_object('key','date_valid',
        'label','วัน-เวลาที่โอนอยู่ในช่วงที่ยอมรับได้','pass',true,'weight',15);
      v_total := v_total + 15; v_earned := v_earned + 15;
    end if;
  end if;

  if p_slip_sha256 ~ '^[0-9a-f]{64}$' then
    v_checks := v_checks || jsonb_build_object('key','hash_format',
      'label','ลายนิ้วมือไฟล์อยู่ในรูปแบบ SHA-256','pass',true,'weight',5);
    v_total := v_total + 5; v_earned := v_earned + 5;
  else
    v_checks := v_checks || jsonb_build_object('key','hash_format',
      'label','ลายนิ้วมือไฟล์ไม่อยู่ในรูปแบบ SHA-256','pass',false,'weight',5);
    v_total := v_total + 5;
    v_blockers := array_append(v_blockers, 'hash_format'::text);
  end if;

  if nullif(btrim(coalesce(p_ref,'')), '') is not null then
    v_checks := v_checks || jsonb_build_object('key','ref_present',
      'label','มีเลขอ้างอิงรายการ','pass',true,'weight',5);
    v_total := v_total + 5; v_earned := v_earned + 5;
  else
    v_checks := v_checks || jsonb_build_object('key','ref_present',
      'label','ไม่มีเลขอ้างอิงรายการ','pass',false,'weight',5);
    v_total := v_total + 5;
  end if;

  return jsonb_build_object(
    'score', case when v_total > 0 then round((v_earned::numeric / v_total) * 100)::int else 0 end,
    'checks', v_checks,
    'blockers', to_jsonb(v_blockers),
    'file', jsonb_build_object('mimetype', v_mime, 'size', v_size),
    'checked_at', now()
  );
end;
$function$;
