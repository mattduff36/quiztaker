import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth';
import { hasValidRequestOrigin } from '@/lib/security';
import { draftPatchSchema,sharedOperations } from '@/lib/shared-operations-store';
import { boundedJson } from '@/lib/bounded-json';
const schema=z.object({helperId:z.string().uuid(),clientId:z.string().uuid(),action:z.enum(['read','edit','begin','renew','end','clear-guidance']),
  revision:z.number().int().nonnegative().optional(),patch:draftPatchSchema.optional(),workflowId:z.string().uuid().optional(),text:z.string().max(2000).optional(),sessionId:z.string().uuid().optional()}).strict();
export async function POST(request:Request) {
  if(!hasValidRequestOrigin(request))return Response.json({error:'Invalid request origin'},{status:403});
  const user=await getAuthenticatedUser();
  if(!user)return Response.json({error:'Unauthorized'},{status:401});
  if(Number(request.headers.get('content-length'))>30_000)return Response.json({error:'Draft too large'},{status:413});
  const parsed=schema.safeParse(await boundedJson(request,30_000).catch(()=>null));
  if(!parsed.success)return Response.json({error:'Invalid shared task request'},{status:400});
  try{return Response.json(await sharedOperations(user.id,parsed.data),{headers:{'Cache-Control':'no-store'}});}
  catch(error){return Response.json({error:error instanceof Error?error.message:'Shared task unavailable'},{status:409});}
}
