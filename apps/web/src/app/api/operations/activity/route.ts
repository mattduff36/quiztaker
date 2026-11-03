import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth';
import { hasValidRequestOrigin } from '@/lib/security';
import { queryOne } from '@/lib/db';
import { operatorActivity, reserveBrowserRefresh } from '@/lib/operator-activity';
import { createCapabilityPlan } from '@/lib/operations';
import { createJob } from '@/lib/jobs';

const schema = z.object({helperId:z.string().uuid(),action:z.enum(['check','activity','resume','pause','refresh']),force:z.boolean().optional()});
export async function POST(request: Request) {
  if (!hasValidRequestOrigin(request)) return NextResponse.json({error:'Invalid request origin'},{status:403});
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({error:'Unauthorized'},{status:401});
  const parsed = schema.safeParse(await request.json().catch(()=>null));
  if (!parsed.success) return NextResponse.json({error:'Invalid activity request'},{status:400});
  const {helperId,action,force} = parsed.data;
  if (!await queryOne('select id from helpers where id=$1 and user_id=$2 and revoked_at is null',[helperId,user.id])) return NextResponse.json({error:'Helper not found'},{status:404});
  try {
    if (action !== 'refresh') return NextResponse.json(await operatorActivity(user.id,helperId,action));
    const activity = await operatorActivity(user.id,helperId);
    if (activity.paused || !await reserveBrowserRefresh(user.id,helperId,force)) return NextResponse.json({status:'skipped'});
    try {
      const plan = await createCapabilityPlan(user.id,{helperId,capabilityId:'list-tabs',capabilityInput:{capabilityId:'list-tabs'},source:'direct-readonly',label:'Refresh browser tabs'});
      return NextResponse.json({status:'queued',...(await createJob(user.id,plan.planId))});
    } catch (error) {
      if (error instanceof Error && /already active|session is paused/i.test(error.message)) return NextResponse.json({status:'skipped'});
      throw error;
    }
  } catch {
    return NextResponse.json({error:'Could not update your session. Check the connection and try again.'},{status:503});
  }
}
