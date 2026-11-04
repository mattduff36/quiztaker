/** Background observations must never replace a task's output or pending question. */
export const isRunningJob = (job?: { status: string } | null) => Boolean(job && ['queued', 'dispatched', 'running'].includes(job.status));
export const isTaskJob = (job?: { capability_id?: string } | null) => Boolean(job && job.capability_id && !['list-tabs', 'cdp-check', 'fit-tab', 'start-browser', 'close-browser', 'open-url', 'tab-inspect', 'cert-status', 'cert-dry-run'].includes(job.capability_id));

export function retainTaskJob<T extends { id: string; capability_id?: string }>(current: T | null | undefined, observed: T | null | undefined): T | null {
  if (!observed) return current ?? null;
  if (current && !isTaskJob(observed) && isTaskJob(current)) return current;
  return observed;
}

export const OBJECTIVE_LIMIT = 1000;

export function describeTaskJob(job?:{capability_id?:string;status:string}|null) {
  const names:Record<string,string>={'quiz-learn':'Course activity','detect':'Inspect course page','learn-capture':'Capture course material','cert-batch':'Course qualification','class-batch':'Course activities'};
  const states:Record<string,string>={'awaiting-input':'Waiting for your answer',queued:'Waiting for the helper',dispatched:'Starting',running:'Working',completed:'Complete',failed:'Failed',cancelled:'Stopped','helper-offline':'Helper disconnected'};
  return `${names[job?.capability_id??'']??'Course task'}: ${states[job?.status??'']??'Ready'}`;
}
