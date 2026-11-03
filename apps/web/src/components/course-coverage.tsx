import type { CourseCoverage as Coverage } from '@/lib/course-coverage';

export function CourseCoverage({ courses }: { courses: Coverage[] }) {
  if (!courses.length) return null;
  return <details className="mt-5 rounded-lg border border-slate-200 bg-white">
    <summary className="cursor-pointer px-5 py-4 text-sm font-semibold text-slate-950 focus-visible:outline-2 focus-visible:outline-cyan-700">Course material checklist</summary>
    <p className="border-t border-slate-200 px-5 pt-4 text-sm leading-6 text-slate-600">Collected means some material was retained. It does not confirm that every panel was read or that the topic was learned.</p>
    {courses.map(course => <section key={course.source} className="p-5">
      <h3 className="font-semibold text-slate-950">{course.title}</h3>
      <p className="mt-1 text-xs leading-5 text-slate-600">{course.inventoryObserved ? `${course.topics.length} topics found · ${course.topics.filter(topic => topic.collectedAt).length} with collected material · ${course.topics.filter(topic => !topic.visitedAt).length} unchecked` : 'Full topic inventory unavailable. These are observed sections only.'}</p>
      <ul className="mt-3 divide-y divide-slate-100">{course.topics.map(topic => <li key={topic.title} className="flex items-start justify-between gap-4 py-2 text-sm"><span className="text-slate-800">{topic.title}</span><span className={`shrink-0 text-xs font-medium ${topic.collectedAt ? 'text-emerald-800' : topic.visitedAt ? 'text-amber-900' : 'text-slate-600'}`}>{topic.collectedAt ? 'Material collected' : topic.visitedAt ? 'Visited · not collected' : 'Unchecked'}</span></li>)}</ul>
    </section>)}
  </details>;
}
