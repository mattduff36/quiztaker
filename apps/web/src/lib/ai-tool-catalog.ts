/** Public capability descriptions, without credentials or server dependencies. */
export function aiToolCatalog(connection: { source: string; ready: boolean; provider: string | null }, helperAvailable: boolean) {
  const openai = connection.ready && connection.source === 'personal' && connection.provider === 'openai';
  return [
    { id:'web_search', name:'Public web search', available:openai, detail:'OpenAI searches public sources; prefer manufacturer documentation. Provider usage charges apply.' },
    { id:'code_interpreter', name:'Python calculations', available:openai, detail:'Python runs in an OpenAI container. It has no local computer access. Generated file downloads are not connected. Provider usage charges apply.' },
    { id:'read_public_page', name:'Read public references', available:openai, detail:'Bounded HTTPS HTML/text reader; no login, private network or LMS sessions.' },
    { id:'search_course_material', name:'Search retained course material', available:openai, detail:'Searches only this account’s saved course material and returns source excerpts.' },
    { id:'calculate', name:'Arithmetic and current time', available:openai, detail:'Small arithmetic parser and current UTC time; no local code execution.' },
    { id:'browser', name:'Course browser actions', available:helperAvailable, detail:'Paired helper: observed controls, course tabs, scroll up/down, find text, screenshot capture and visible-result verification. A running authorized job is required.' },
    { id:'vision', name:'Screenshot understanding', available:openai && helperAvailable, detail:'One captured JPEG can accompany the next decision when the selected OpenAI model supports vision.' },
  ];
}
