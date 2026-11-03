/** Present historical evidence without turning a bare score/object into a pass. */
export function historyResult(value: unknown, payload?: unknown): string {
  const seen = new Set<object>();
  function read(input: unknown, depth = 0): string | null {
    if(depth>6 || input==null)return null;
    if(typeof input==='string') {
      const text=input.trim();
      if(!text || /^\[object Object\]$/i.test(text))return null;
      if(/^[{[]/.test(text)&&text.length<8000){try{return read(JSON.parse(text),depth+1);}catch{return null;}}
      return text.slice(0,200);
    }
    if(typeof input==='number')return Number.isFinite(input)?`Score: ${input}`:null;
    if(typeof input==='boolean')return input?'Completed':'Failed';
    if(typeof input!=='object'||seen.has(input))return null;
    seen.add(input);
    const row=input as Record<string,unknown>;
    // Final state wins over a previous/initial state in legacy SCORM receipts.
    for(const key of ['after','lesson_status','cmi.core.lesson_status','success_status','cmi.success_status','success','completion_status','cmi.completion_status','completion','status','outcome','result','status_set']) {
      const result=read(row[key],depth+1);if(result)return result;
    }
    if(typeof row.passed==='boolean')return row.passed?'Passed':'Failed';
    if(typeof row.ok==='boolean')return row.ok?'Completed':'Failed';
    return null;
  }
  return read(value) || read(payload) || 'Not recorded';
}
