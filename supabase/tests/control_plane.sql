begin;
create extension if not exists pgtap with schema extensions;

select plan(20);
select has_table('public', 'profiles');
select has_table('public', 'helpers');
select has_table('public', 'pairing_codes');
select has_table('public', 'plans');
select has_table('public', 'jobs');
select has_table('public', 'job_events');
select has_table('public', 'attempt_events');
select has_table('public', 'history_events');
select has_table('public', 'strategies');
select has_table('public', 'review_items');
select has_table('public', 'artifacts');

select ok((select relrowsecurity from pg_class where oid = 'public.helpers'::regclass), 'helpers RLS is enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.plans'::regclass), 'plans RLS is enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.jobs'::regclass), 'jobs RLS is enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.artifacts'::regclass), 'artifacts RLS is enabled');

select has_function('public', 'consume_plan_and_create_job', array['uuid', 'uuid', 'uuid']);
select has_function('public', 'claim_next_helper_job', array['uuid', 'uuid']);
select has_index('public', 'jobs', 'jobs_helper_poll_idx');
select has_index('public', 'job_events', 'job_events_job_sequence_idx');
select col_is_unique('public', 'job_events', array['job_id', 'sequence']);

select * from finish();
rollback;
