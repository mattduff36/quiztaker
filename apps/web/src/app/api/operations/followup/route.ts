import {z} from 'zod';
import {getAuthenticatedUser} from '@/lib/auth';
import {hasValidRequestOrigin} from '@/lib/security';
import {queryOne} from '@/lib/db';
import {boundedJson} from '@/lib/bounded-json';
import {cancelTaskFollowup,expireTaskFollowup} from '@/lib/task-followup';
const schema=z.object({helperId:z.string().uuid(),jobId:z.string().uuid(),action:z.enum(['cancel','expire'])}).strict();
export async function POST(request:Request){
  if(!hasValidRequestOrigin(request))return Response.json({error:'Invalid request origin'},{status:403});
  const user=await getAuthenticatedUser();if(!user)return Response.json({error:'Unauthorized'},{status:401});
  const parsed=schema.safeParse(await boundedJson(request,2048).catch(()=>null));if(!parsed.success)return Response.json({error:'Invalid follow-up request'},{status:400});
  const input=parsed.data;if(!await queryOne('select id from helpers where id=$1 and user_id=$2 and revoked_at is null',[input.helperId,user.id]))return Response.json({error:'Helper not found'},{status:404});
  try{if(input.action==='cancel'){await cancelTaskFollowup(user.id,input.helperId,input.jobId);return Response.json({status:'kept-open'});}return Response.json(await expireTaskFollowup(user.id,input.helperId,input.jobId));}
  catch{return Response.json({error:'Could not end the browser session. Check its status before trying again.'},{status:409});}
}
