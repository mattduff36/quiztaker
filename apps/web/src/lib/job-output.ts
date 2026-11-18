/** Preserve split stdout chunks while separating whole structured records emitted as distinct events. */
export function jobOutput(events: ReadonlyArray<{data?:{text?:string}}>): string {
  let output = '';
  for (const event of events) {
    const text = event.data?.text ?? '';
    if (output && !output.endsWith('\n') && /^(?:LEARNER_[A-Z_]+|AUTOMATION_RESULT|QUICK_SCRAPE_[A-Z_]+) /.test(text)) output += '\n';
    output += text;
  }
  return output;
}
