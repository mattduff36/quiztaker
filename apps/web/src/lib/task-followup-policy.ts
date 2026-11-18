export const TASK_FOLLOWUP_MS=20_000;
export type TaskFollowup={jobId:string;sessionId:string;deadline:string;serverNow:string;state:'waiting'|'cancelled'|'closing'|'closed'|'failed';closeJobId:string|null};
const work=new Set(['quiz-learn','quick-scrape','scorm-complete','cert-batch','class-batch','container-batch','slickquiz-solve']);
export function completedCourseTask(job:{status:string;capability_id:string;outcome?:{verified?:boolean;operatorResolution?:{result?:string}}|null}) {
  return work.has(job.capability_id)&&job.status==='completed'&&(job.outcome?.verified===true||job.outcome?.operatorResolution?.result==='completed');
}
