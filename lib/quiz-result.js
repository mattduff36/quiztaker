// Recognize terminal quiz feedback from the current rendered view only. Never
// use retained course memory, page titles, hidden DOM or an answer key as proof.
function recognizeQuizResult(snapshot) {
  if (snapshot?.choices?.length) return null;
  const texts = Array.isArray(snapshot?.resultViews) ? snapshot.resultViews : [snapshot?.text || ''];
  const results = texts.map(parseResultView).filter(Boolean);
  // A visible negative result always takes precedence over positive feedback.
  return results.find(result => result.status === 'failed') || results[0] || null;
}

function parseResultView(value) {
  const text = String(value || '').replace(/\r/g, '').trim();
  if (!text || /\b(?:previous (?:results?|attempts?)|attempt history|results? history|review (?:questions?|answers?)|question\s+\d+\s+of\s+\d+)\b/i.test(text)) return null;
  if (/\b(?:for example|example result|instructions?|if you pass|when you pass|you will see)\b/i.test(text)) return null;
  const header = /(?:^|\n)[ \t]*(?:(?:(?:test|quiz|assessment|exam) )?results?|results? summary|test summary)(?:[ \t]+[-–—][ \t]+[^\n]{1,120})?[ \t]*(?:\n|$)/i.test(text);
  const status = [...text.matchAll(/(?:^|\n)\s*(?:pass\s*\/\s*fail|(?:test |quiz |assessment )?(?:result|status))\s*:?\s*(passed|pass|failed|fail|unsuccessful|not passed)\b(?=\s*(?:\n|$))/gi)];
  if (header) status.push(...text.matchAll(/(?:^|\n)\s*(passed|pass|failed|fail|unsuccessful|not passed)\s*(?=\n|$)/gi));
  const directPass = /(?:^|\n)\s*(?:congratulations[!,.]?\s*)?you (?:have )?passed(?: (?:this|the) (?:quiz|test|assessment|exam))?[.!]?(?:\s*your score\s*:\s*\d+(?:\.\d+)?\s*%[.!]?)?\s*(?=\n|$)/i.exec(text);
  const directFail = /(?:^|\n)\s*you (?:(?:have |did )?not (?:passed|pass)|haven't passed|failed)\b[^\n]*(?:\n|$)/i.exec(text);
  const numeric = (label, percent = false) => {
    const match = text.match(new RegExp(`(?:^|\\n|[.!]\\s+)\\s*(?:${label})\\s*:?\\s*(\\d+(?:\\.\\d+)?)${percent ? '\\s*%' : '(?![\\d.])'}`, 'i'));
    const number = match ? Number(match[1]) : undefined;
    return number !== undefined && (percent ? number <= 100 : Number.isInteger(number)) ? number : undefined;
  };
  const scorePercent = numeric('percent correct|overall score|your score|score', true);
  const passingScorePercent = numeric('passing score|pass mark|passing grade', true);
  const fraction = text.match(/(?:^|\n)\s*overall score\s*:?\s*\d+(?:\.\d+)?\s*%\s*\(\s*(\d+)\s*out of\s*(\d+)\s*\)/i);
  const questionsTotal = numeric('questions on test|total questions|number of questions') ?? (fraction ? Number(fraction[2]) : undefined);
  const questionsCorrect = numeric('questions correct|correct answers') ?? (fraction ? Number(fraction[1]) : undefined);
  const questionsIncorrect = numeric('questions incorrect|incorrect answers');
  const belowThreshold = scorePercent !== undefined && passingScorePercent !== undefined && scorePercent < passingScorePercent;
  const hasMetrics = scorePercent !== undefined && passingScorePercent !== undefined;
  // Instructions such as "you must score 70%" and a score alone are not results.
  if (!directPass && !directFail && !(header && (status.length || hasMetrics))) return null;
  const failed = Boolean(directFail || status.some(match => /^(?:failed?|unsuccessful|not passed)$/i.test(match[1])) || (header && belowThreshold));
  const passed = Boolean(directPass || status.some(match => /^pass(?:ed)?$/i.test(match[1])) || (header && hasMetrics && !belowThreshold));
  if (!failed && !passed) return null;
  const result = { status: failed ? 'failed' : 'passed', evidence: [text.slice(0, 2400)] };
  for (const [key, number] of Object.entries({scorePercent, passingScorePercent, questionsTotal, questionsCorrect, questionsIncorrect})) {
    if (number !== undefined && number >= 0 && (key.includes('Percent') ? number <= 100 : Number.isInteger(number))) result[key] = number;
  }
  return result;
}

function quizResultPayload(result) {
  const completed = result.status === 'passed';
  return {
    completed: completed ? 1 : 0, total: 1, quizResult: result,
    ...(!completed ? {failures: [{title: 'quiz-learn', reason: 'quiz-failed', evidence: result.evidence}]} : {}),
  };
}

module.exports = { recognizeQuizResult, quizResultPayload };
