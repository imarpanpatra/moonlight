// What the clause does, detected in code.
//
// This file exists because of an eval result. Asked to classify whether a
// clause reaches outside the job, gemma3:4b scored 7/14 and answered "yes" to
// 13 of 14 clauses. Asked to quote the operative sentence, it scored 14/14.
//
// So the model does the quoting and none of the judging. The properties below
// are the ones that actually change what you should do about a clause, and
// every one of them is a phrase you can match. Each flag carries the text that
// triggered it, so the reader can check the flag the same way they can check
// the quote.

const FLAGS = [
  {
    id: 'requires_consent',
    label: 'Asks permission, not a ban',
    note: 'This clause is a gate, not a wall. There is something to ask for.',
    patterns: [
      /without the (?:prior |previous )?(?:written )?(?:consent|approval|permission)[^.,]{0,40}/i,
      /(?:prior|previous) written (?:consent|approval|permission)/i,
      /shall (?:first )?(?:obtain|seek|apply for)[^.]{0,40}(?:consent|approval|permission)/i,
      /consent shall not be unreasonably withheld/i,
    ],
  },
  {
    id: 'survives_termination',
    label: 'Outlives the job',
    note: 'This one still binds you after you leave.',
    patterns: [
      /(?:at any time )?after (?:its |the )?termination/i,
      /following (?:the )?termination/i,
      /shall survive[^.,]{0,60}/i,
      /for a period of[^.]{0,60}after/i,
    ],
  },
  {
    id: 'beyond_working_hours',
    label: 'Reaches past working hours',
    note: 'Evenings and weekends are inside this clause, not outside it.',
    patterns: [
      /whether or not during working hours/i,
      /outside (?:of )?(?:working|business|office) hours/i,
      /at all times/i,
      /during employment or at any time/i,
    ],
  },
  {
    id: 'regardless_of_relevance',
    label: 'Applies even if unrelated',
    note: 'It does not matter that your project has nothing to do with their business.',
    patterns: [
      /whether or not relating to[^.,]{0,60}/i,
      /whether or not such activity competes/i,
      /whether or not for remuneration/i,
      /whether or not connected (?:with|to)[^.,]{0,50}/i,
    ],
  },
  {
    id: 'regardless_of_resources',
    label: 'Applies on your own equipment',
    note: 'Building it on your own laptop, in your own time, does not take it outside this clause.',
    patterns: [
      /whether or not using the (?:resources|equipment|facilities|property)[^.,]{0,40}/i,
      /whether or not (?:company )?(?:resources|equipment|facilities) (?:are|were) used/i,
    ],
  },
  {
    id: 'duty_to_disclose',
    label: 'You must tell them',
    note: 'Silence is itself a breach here, separate from whatever you are doing.',
    patterns: [
      /shall (?:promptly )?(?:disclose|notify|inform|declare)[^.,]{0,60}/i,
      /must (?:promptly )?(?:disclose|notify|inform|declare)[^.,]{0,60}/i,
      /shall (?:promptly )?(?:report|bring to the attention)[^.,]{0,50}/i,
    ],
  },
  {
    id: 'assigns_ownership',
    label: 'Transfers ownership',
    note: 'This is the clause that decides who owns the thing you built.',
    patterns: [
      /(?:hereby )?assigns? to the [Cc]ompany[^.,]{0,60}/i,
      /shall (?:be|become|vest(?: in)?)[^.]{0,30}(?:sole and exclusive|exclusive|sole) property[^.]{0,30}/i,
      /shall vest in the [Cc]ompany/i,
      /works made for hire/i,
    ],
  },
];

/** A stated duration, which is the one number in these clauses worth surfacing. */
const DURATION = /(?:for a period of\s+)?(\w+(?:[- ]\w+)?)\s*\((\d+)\)\s*(months?|years?)/i;

/**
 * Inspect one clause. Returns the flags that fired, each with its evidence.
 *
 * No model is involved. If a flag is wrong, it is wrong in a way you can see,
 * because it shows you the words it matched on.
 */
export function detect(clauseText) {
  // Collapsed first. A contract is hard-wrapped, so "without the prior\nwritten
  // consent of the Company" contains a newline exactly where a pattern wants a
  // space, and every one of these phrases would silently fail to match.
  const text = String(clauseText || '').replace(/\s+/g, ' ');
  const found = [];

  for (const flag of FLAGS) {
    for (const pattern of flag.patterns) {
      const m = text.match(pattern);
      if (m) {
        found.push({
          id: flag.id,
          label: flag.label,
          note: flag.note,
          evidence: m[0].replace(/\s+/g, ' ').trim(),
        });
        break; // One hit per flag is enough; the first is the clearest.
      }
    }
  }

  const d = text.match(DURATION);
  const duration = d ? `${d[2]} ${d[3].toLowerCase()}` : null;

  return { flags: found, duration };
}

export const FLAG_IDS = FLAGS.map((f) => f.id);
