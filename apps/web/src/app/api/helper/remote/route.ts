import { z } from 'zod';
import { authenticateHelper } from '@/lib/security';
import { remoteHelper } from '@/lib/remote-relay';
import { boundedJson } from '@/lib/bounded-json';
const sealed=z.object({seq:z.number().int().positive(),expiresAt:z.number().int(),iv:z.string().max(20),ciphertext:z.string().max(900_000)}).strict();
const schema=z.object({idle:z.boolean(),updates:z.array(z.object({
  sessionId:z.string().uuid(),publicKey:z.string().max(100),frame:sealed.optional(),ack:z.number().int().nonnegative().optional(),status:z.string().max(160).optional(),
}).strict()).max(4)}).strict();
export async function POST(request:Request) {
  const helper=await authenticateHelper(request);
  if(!helper)return Response.json({error:'Unauthorized helper'},{status:401});
  if(Number(request.headers.get('content-length'))>3_700_000)return Response.json({error:'Frames too large'},{status:413});
  const parsed=schema.safeParse(await boundedJson(request,3_700_000).catch(()=>null));
  if(!parsed.success)return Response.json({error:'Invalid remote exchange'},{status:400});
  try{return Response.json(await remoteHelper(helper.userId,helper.helperId,parsed.data),{headers:{'Cache-Control':'no-store'}});}
  catch{return Response.json({error:'Remote exchange failed. Reconnect the viewer.'},{status:409});}
}
