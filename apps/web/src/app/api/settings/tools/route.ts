import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { hasValidRequestOrigin } from '@/lib/security';
import { queryOne } from '@/lib/db';
import { aiToolCatalog } from '@/lib/ai-tool-catalog';
import { chooseProposalLearner, completeHostedChat, CONNECTION_TEST_SNAPSHOT, decryptLlmKey, llmCredentialKey, loadSecretLlmConnection, readPublicLlmConnection, readSettingsBody } from '@/lib/llm-provider';

export const maxDuration = 120;

export async function GET() {
  const user = await getAuthenticatedUser(); if (!user) return NextResponse.json({error:'Unauthorized'},{status:401});
  const connection = await readPublicLlmConnection(user.id);
  const helper = await queryOne<{id:string}>('select id from helpers where user_id=$1 and revoked_at is null limit 1',[user.id]);
  return NextResponse.json({tools:aiToolCatalog(connection,Boolean(helper))});
}

export async function POST(request: Request) {
  if (!hasValidRequestOrigin(request)) return NextResponse.json({error:'Invalid request origin'},{status:403});
  const user = await getAuthenticatedUser(); if (!user) return NextResponse.json({error:'Unauthorized'},{status:401});
  const raw = await readSettingsBody(request); let tool: unknown;
  try { tool = JSON.parse(raw || '{}').tool; } catch { /* Invalid input below. */ }
  if (tool !== 'web_search' && tool !== 'code_interpreter') return NextResponse.json({error:'Choose a supported tool test'},{status:400});
  const reservation = await queryOne<{request_id:string}>(`insert into llm_connection_tests (user_id) values ($1)
    on conflict (user_id) do update set request_id=gen_random_uuid(),requested_at=now()
    where llm_connection_tests.user_id=$1 and llm_connection_tests.requested_at < now()-interval '30 seconds' returning request_id`,[user.id]);
  if (!reservation) return NextResponse.json({error:'Wait 30 seconds before testing again.'},{status:429});
  try {
    const choice = chooseProposalLearner(await loadSecretLlmConnection(user.id));
    if (choice.kind !== 'personal' || choice.provider !== 'openai') return NextResponse.json({error:'Connect and test a personal OpenAI model first.'},{status:400});
    const apiKey = decryptLlmKey(user.id,choice,llmCredentialKey(process.env.LLM_CREDENTIAL_KEY),choice.provider);
    const result = await completeHostedChat({provider:choice.provider,model:choice.model,apiKey,userId:user.id,snapshot:CONNECTION_TEST_SNAPSHOT,testTool:tool});
    return NextResponse.json({ok:result.ok,tool,model:choice.model,evidence:result.evidence || [],...(!result.ok ? {error:result.error} : {})},{status:result.ok ? 200 : 400});
  } catch { return NextResponse.json({error:'Tool test could not complete. Check the saved connection and try again.'},{status:503}); }
}
