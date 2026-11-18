export type SharedQuestion={question:string;options?:string[];next?:string;model?:boolean;targetId?:string;cdpTargetId?:string;sessionId?:string;url?:string;intent?:'read'|'quiz'|'read-and-assess'|'coordinate'};
export type OperationsDraft={
  selectedTarget:string; selectedCdpTarget:string; objective:string; objectiveEdited:boolean; mode:'independent'|'coordinate'|'quick';
  chosenIntent:'read'|'quiz'|'read-and-assess'|null;
  answer:string; guidance:string; question:SharedQuestion|null;
};
export type SharedSnapshot={revision:number;sessionId:string|null;clientId:string|null;draft:Partial<OperationsDraft>;
  workflowId:string|null;workflowClientId:string|null;workflowUntil:string|null;manual:boolean};
export const EMPTY_SHARED:SharedSnapshot={revision:0,sessionId:null,clientId:null,draft:{},workflowId:null,workflowClientId:null,workflowUntil:null,manual:false};
export function defaultOperationsObjective(mode:string,title='the selected course page') {
  return mode==='coordinate'
    ? `Use the progress and lesson checklist on ${title} to complete required unfinished lessons, then answer the assessment questions and verify the visible results. Ask the connected Codex chat for guidance if progress is blocked.`.slice(0,1000)
    : 'Read the course material, follow its topics and panels, and retain it for later questions.';
}

/** Pending per-field edits win over delayed reads/acks; conflicts rebase, never echo remote edits. */
export class SharedDraftReplica {
  snapshot=EMPTY_SHARED;
  pending:Partial<OperationsDraft>={};
  private generation=0;
  private edited:Partial<Record<keyof OperationsDraft,number>>={};
  edit(patch:Partial<OperationsDraft>) {
    this.generation++;this.pending={...this.pending,...patch};
    for(const key of Object.keys(patch) as Array<keyof OperationsDraft>)this.edited[key]=this.generation;
  }
  forgetGuidance(text:string) {if(this.pending.guidance?.trim()===text){delete this.pending.guidance;delete this.edited.guidance;this.generation++;}}
  request() {return {revision:this.snapshot.revision,patch:{...this.pending},generation:this.generation};}
  receive(value:SharedSnapshot,ack?:{generation:number;patch:Partial<OperationsDraft>}) {
    if(ack&&value.sessionId===this.snapshot.sessionId)for(const key of Object.keys(ack.patch) as Array<keyof OperationsDraft>){
      const generation=this.edited[key];
      if(generation!==undefined&&generation<=ack.generation){delete this.pending[key];delete this.edited[key];}
    }
    if(value.revision<this.snapshot.revision)return;
    if(this.snapshot.revision>0&&value.sessionId!==this.snapshot.sessionId){this.pending={};this.edited={};this.generation++;}
    this.snapshot=value;
  }
  get draft():Partial<OperationsDraft>{return {...this.snapshot.draft,...this.pending};}
}
