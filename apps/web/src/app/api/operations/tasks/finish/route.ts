import {NextResponse} from 'next/server';
import {z} from 'zod';
import {getAuthenticatedUser} from '@/lib/auth';
import {hasValidRequestOrigin} from '@/lib/security';
import {finishOperatorTask} from '@/lib/task-completion';

const schema=z.object({helperId:z.string().uuid(),jobId:z.string().uuid(),result:z.enum(['completed','failed']),note:z.string().max(1000).optional()});
export async function POST(request:Request) {
  if(!hasValidRequestOrigin(request))return NextResponse.json({error:'Invalid request origin'},{status:403});
  const user=await getAuthenticatedUser();
  if(!user)return NextResponse.json({error:'Unauthorized'},{status:401});
  const parsed=schema.safeParse(await request.json().catch(()=>null));
  if(!parsed.success)return NextResponse.json({error:'Invalid task result'},{status:400});
  try{return NextResponse.json(await finishOperatorTask({userId:user.id,...parsed.data}));}
  catch(error){const message=error instanceof Error?error.message:'Could not finish the task';return NextResponse.json({error:message},{status:/not found/.test(message)?404:409});}
}
