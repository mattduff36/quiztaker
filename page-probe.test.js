const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyUrl, fingerprintFor } = require('./lib/page-probe');

test('classifies documented Saba URL variants', () => {
  const cases = [
    ['https://login3.id.hp.com/login', 'session-dead'],
    ['https://content-na2prd0004-na2hp.sabacloud.com/content/rcs/remote_frameset_modern.html', 'scorm-player'],
    ['https://hpi-external.sabacloud.com/Saba/Web_spf/HPI/app/content-player?contextid=1', 'content-player'],
    ['https://hpi-external.sabacloud.com/Saba/Web_spf/HPI/app/me/ledetail/crtfy1', 'cert-landing'],
    ['https://hpi-external.sabacloud.com/Saba/Web_spf/HPI/app/me/learningeventdetail/cours1', 'class-detail'],
    ['https://hpi-external.sabacloud.com/content/socialtenantngx/tool', 'external-tool'],
  ];
  for (const [url, expected] of cases) assert.equal(classifyUrl(url), expected);
});

test('fingerprint is stable and changes with relevant signals', () => {
  const base = {
    schemaVersion: 1,
    urlKind: 'content-player',
    host: 'example.test',
    path: '/content',
    scorm: null,
    hasSlickQuiz: false,
    hasAssessmentShell: true,
    hasActivityRows: false,
    hasDocumentContent: false,
    inputKinds: ['radio'],
    buttons: [{ text: 'Start', title: '', aria: '' }],
  };
  assert.equal(fingerprintFor(base), fingerprintFor({ ...base, capturedAt: 'ignored' }));
  assert.notEqual(fingerprintFor(base), fingerprintFor({ ...base, hasAssessmentShell: false }));
});
