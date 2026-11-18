import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth';
import { hasValidRequestOrigin } from '@/lib/security';
import { remoteViewer } from '@/lib/remote-relay';
import { boundedJson } from '@/lib/bounded-json';
const schema=z.object({
  helperId:z.string().uuid(),clientId:z.string().uuid(),sessionId:z.string().uuid(),
  action:z.enum(['open','poll','close','control','release','input','view-tab']),publicKey:z.string().max(100).optional(),
  command:z.object({seq:z.number().int().positive(),expiresAt:z.number().int(),iv:z.string().max(20),ciphertext:z.string().max(40_000)}).optional(),
}).strict();
export async function POST(request:Request) {
  if(!hasValidRequestOrigin(request))return Response.json({error:'Invalid request origin'},{status:403});
  const user=await getAuthenticatedUser();
  if(!user)return Response.json({error:'Unauthorized'},{status:401});
  if(Number(request.headers.get('content-length'))>50_000)return Response.json({error:'Input too large'},{status:413});
  const parsed=schema.safeParse(await boundedJson(request,50_000).catch(()=>null));
  if(!parsed.success)return Response.json({error:'Invalid remote request'},{status:400});
  try{return Response.json(await remoteViewer(user.id,parsed.data),{headers:{'Cache-Control':'no-store'}});}
  catch(error){return Response.json({error:error instanceof Error?error.message:'Browser relay unavailable'},{status:409});}
}
