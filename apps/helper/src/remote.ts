import { createRemoteKeys, deriveRemoteKey, openRemote, sealRemote, type RemoteContext, type RemoteInput, type SealedRemote } from '@quiztaker/core/remote';
import { RemoteBrowser } from './remote-browser.js';
export type RemoteExchange={sessions:Array<{sessionId:string;clientId:string;viewerKey:string;reserved:boolean;manual:boolean;command:(SealedRemote&{viewOnly?:boolean})|null;leaseUntil:number}>;manualReserved:boolean;leaseUntil?:number};
type Update={sessionId:string;publicKey:string;frame?:SealedRemote;ack?:number;status?:string};
export type RemoteExchangeInput={idle:boolean;updates:Update[]};
type Endpoint={context:RemoteContext;publicKey:string;key:CryptoKey;frameSeq:number;inputSeq:number;ack:number;status:string};

/** Independent bounded poller: never blocks heartbeat, job polling, or history sync. */
export class RemoteBroker {
  private endpoints=new Map<string,Endpoint>();
  private timer:ReturnType<typeof setTimeout>|null=null;
  private stopped=false;
  private reserved=false;
  private reservationUntil=0;
  private inputActive=false;
  private generation=0;
  private announced=false;
  private updates:Update[]=[];
  constructor(private readonly helperId:string,private readonly exchange:(input:RemoteExchangeInput)=>Promise<RemoteExchange>,
    private readonly idle:()=>boolean,private readonly notice:(message:string)=>void,
    private readonly browser=new RemoteBrowser(`http://127.0.0.1:${Number(process.env.PLAYWRIGHT_CDP_PORT||9222)}`),private readonly now:()=>number=Date.now) {}
  get blocksAutomation():boolean {return (this.reserved&&this.now()<this.reservationUntil)||this.inputActive;}
  start() {void this.tick();}
  stop() {this.stopped=true;this.generation++;if(this.timer)clearTimeout(this.timer);this.endpoints.clear();this.browser.clear();}
  private async tick() {
    const generation=this.generation;
    try{
      const result=await this.exchange({idle:this.idle()&&!this.inputActive,updates:this.updates});
      this.updates=[];
      if(this.stopped||generation!==this.generation)return;
      this.reserved=result.manualReserved;
      this.reservationUntil=result.manualReserved&&Number.isFinite(result.leaseUntil)
        ? Math.min(Number(result.leaseUntil),this.now()+15_000):0;
      const manual=result.sessions.some(session=>session.manual);
      if(manual!==this.announced){this.announced=manual;this.notice(manual?'Manual browser control · Operations viewer':'Manual browser control released');}
      const live=new Set(result.sessions.map(session=>session.sessionId));
      for(const id of this.endpoints.keys())if(!live.has(id))this.endpoints.delete(id);
      if(!live.size)this.browser.clear();
      for(const session of result.sessions) {
        let endpoint=this.endpoints.get(session.sessionId);
        if(!endpoint) {
          const keys=await createRemoteKeys();
          endpoint={context:{helperId:this.helperId,sessionId:session.sessionId,clientId:session.clientId},publicKey:keys.publicKey,
            key:await deriveRemoteKey(keys.privateKey,session.viewerKey),frameSeq:0,inputSeq:0,ack:0,status:'Connected'};
          this.endpoints.set(session.sessionId,endpoint);
        }
        if(session.command) {
          try {
            const command=await openRemote<RemoteInput>(endpoint.key,endpoint.context,'input',session.command,endpoint.inputSeq);
            endpoint.inputSeq=session.command.seq;
            const viewOnly=session.command.viewOnly===true;
            const deadline=Math.min(session.command.expiresAt,viewOnly?Infinity:session.leaseUntil-1000,Date.now()+5000);
            this.inputActive=true;
            try {await this.browser.input(command,()=>!this.stopped&&Date.now()<deadline&&(viewOnly||(session.manual&&this.reserved&&this.idle())),viewOnly);}
            finally {this.inputActive=false;}
            endpoint.status='Input applied';
          }catch {endpoint.status='Input not applied. Wait for a fresh image and retry.';}
          endpoint.ack=Math.max(endpoint.ack,session.command.seq);
        }
        const update:Update={sessionId:session.sessionId,publicKey:endpoint.publicKey,ack:endpoint.ack,status:endpoint.status};
        try {
          const frame=await this.browser.frame(session.manual);
          if(this.stopped)return;
          update.frame=await sealRemote(endpoint.key,endpoint.context,'frame',++endpoint.frameSeq,frame);
        }catch {update.status='Course browser unavailable or changing. Retrying; no window settings were changed.';}
        this.updates.push(update);
      }
    }catch {
      // No exception/payload reaches the terminal: login input and frames are private.
      if(this.endpoints.size)this.notice('Private browser relay reconnecting. Remote input is unavailable.');
      this.updates=[];
    }finally{
      if(!this.stopped)this.timer=setTimeout(()=>void this.tick(),this.endpoints.size?700:2000);
    }
  }
}
