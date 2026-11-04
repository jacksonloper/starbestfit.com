/* STAR Voting definitions and tabulation routines
 *
 * We adhere as closely as possible to the official STAR Voting protocol.
 * However, some deviations are necessary to adapt STAR to this application.
 *
 * Basic rules:         https://starvoting.org/star
 * Tiebreaking rules:   https://starvoting.org/ties
 *
 * In STAR Voting, candidate times are scored 0 to 5 stars. The two highest
 * scoring candidates proceed to the runoff round. In the runoff, each person's
 * full vote goes to the candidate they prefer, if they had a preference.
 *
 *
 * # Scores for "Meeting Times" Average the Component Timeslot Scores
 *
 * In the app, people score times in 15-minute timeslots. This is less than a
 * meeting might actually be scheduled for. E.g. 60 minutes encompasses 4
 * timeslots. We need a way to consider someone's score for the full meeting
 * time. To do this, a person's score for a meeting time is calculated to be the
 * average of the scores that they gave to each of its component timeslots.
 *
 *
 * # Explicit Ties
 *
 * The official STAR protocol resolves every tie down to a single winner,
 * ultimately with a coin toss. For scheduling, a coin toss hides information:
 * if two times are genuinely tied, the group should see both and decide for
 * themselves. So instead of picking exactly two finalists and exactly one
 * winner, we compute a *set* of best times using only head-to-head matchups,
 * and we never break a tie ourselves:
 *
 * 1. Scoring round. Let N be the number of start times sharing the highest
 *    total score and M the number sharing the second highest.
 *    - If N >= 2, the finalists are the N top scoring times.
 *    - If N == 1, the finalists are the top scoring time plus the M second
 *      highest scoring times (N + M finalists in total).
 *    This is the set of times that could have made the official runoff.
 *
 * 2. Runoff round. Every pair of finalists is compared head-to-head: a person
 *    prefers the time they gave the higher (averaged) score. The best times
 *    are the finalists that win or tie *every* head-to-head matchup against
 *    the other finalists. All of them are shown as tied for best, highest
 *    total score first, then chronologically.
 *
 * 3. Cycles. It is possible that every finalist loses at least one matchup
 *    (A beats B, B beats C, C beats A). Then no time satisfies rule 2. We do
 *    not try to break this: every finalist is shown, and the explanation
 *    says that none of them is unbeaten.
 *
 * Every 15-minute start time is its own candidate. Meetings starting at 11:00
 * and 11:15 overlap heavily and will often tie, in which case both are shown.
 *
 * Note the differences from the official protocol, which are deliberate:
 * - Official STAR breaks a scoring-round tie by *most* head-to-head wins;
 *   we require *no* head-to-head losses, which is stricter and can disagree
 *   (e.g. a time that ties everyone else has zero wins but zero losses).
 * - Official STAR breaks a runoff tie in favour of the higher scored time;
 *   we show a runoff tie as a tie, even when one of the two had the higher
 *   score.
 * - Official STAR picks a single second finalist from among tied second
 *   scorers; we compare against all of them at once.
 * - Official STAR falls back to five-star counts and a coin toss; we never
 *   do, so the result is fully determined by the ballots.
 *
 *
 * # Inspection
 *
 * As of this writing, details about the tabulation are logged in the browser's
 * console. You can look at this object to better understand how a result was
 * computed.
 *
 * The top-level object contains info for the scoring round (the top and second
 * scores and the finalists), the runoff round (the head-to-head matchup
 * matrix, each finalist's wins and losses, whether a cycle occurred, and the
 * best candidates), and the final results to display.
 *
 * Candidate objects include the time ("date") of the candidate in UTC, the
 * scores each person gave to a full event of the desired duration if it starts
 * at that time, the total score given to the time, and the number of
 * head-to-head wins among the finalists.
 */

import { Temporal } from '@js-temporal/polyfill'

import { PersonResponse, TimeScore } from '/src/config/api'
import { Availability, calculateAvailability, NameScore } from '/src/utils/calculateAvailability'

import { convertTimesToDates } from './convertTimesToDates'

export const MAXSCORE = 5 // minimum score always assumed to be 0
export const TIMESLOT_MINUTES = 15 // length of timeslots in minutes

// Get the current score for a time given some availability. If a time is not
// present in the availability, we assume its value is zero.
export const getScoreForTime = (time: string, availability: TimeScore[]): number => {
  const timescore = availability.find(item => item.time === time)
  return timescore ? timescore.score : 0
}

// Filter out times where the score is 0. In our representation, any missing
// times are assumed to be a zero score, so we can avoid persisting them and use
// their absence as an indicator of unavailability.
export const dropZeroScores = (availability: TimeScore[]): TimeScore[] => {
  return availability.filter(item => item.score > 0)
}

// Calculate the average score given to a time given the total sum of its score
// and the number of people that voted.
export const calcAverageScore = (totalScore: number, numPeople: number): number => {
  return numPeople ? (totalScore / numPeople) : 0
}

export const averageAndRound = (score: number, numPeople: number): number => {
  return Math.round(calcAverageScore(score, numPeople) * 100) / 100
}



/***** STAR Voting Tabulation *****/

export type TieBreak =
  // there was only one candidate, so no comparisons were needed
  | 'none'
  // bestTimes are exactly the finalists that won or tied every head-to-head
  // matchup against the other finalists
  | 'headToHead'
  // every finalist lost at least one matchup (a cycle), so no time is
  // unbeaten; bestTimes lists every finalist
  | 'cycle'

export interface StarResults {
  // All times tied for best (see "Explicit Ties" above), highest
  // total score first, then chronological. Empty when there are no
  // candidates, e.g. no people.
  bestTimes: TimeScore[],
  // The times compared head-to-head to decide the best time: every time with
  // the highest score if two or more share it, otherwise the highest scoring
  // time followed by every time with the second highest score. Each group is
  // in chronological order.
  finalists: TimeScore[],
  // Number of finalists that share the highest score (N in the docstring)
  numTopScorers: number,
  // How bestTimes relate to the other finalists (undefined when there are no
  // candidates)
  tieBreak?: TieBreak,
  // Defined only when there are exactly two finalists: the number of people
  // who preferred finalists[0] over finalists[1], and vice versa. People with
  // no preference are not counted in either.
  firstVotes?: number,
  secondVotes?: number,
}

export const calculateBestTime = (
  times_orig: string[],
  people: PersonResponse[],
  duration: number, // meeting duration in minutes
  timeMap: TimeMap,
): StarResults => {
  if (people.length === 0) {
    return ({ bestTimes: [], finalists: [], numTopScorers: 0 })
  }
  const t0 = performance.now()
  // An bug was encountered in which there was a duplicated 24-hour block at
  // the beginning of this array, which caused the calculation to fail and the
  // app to crash. We deduplicate the times here to mitigate this issue.
  const times = Array.from(new Set(times_orig))
  const fullPeopleScores = replaceScoresWithFullScores(times, people, duration, timeMap)
  // collate the list of people's responses to the candidate times
  const dateCollated = calculateAvailability(times, fullPeopleScores)
  const candidates: Candidate[] = dateCollated.availabilities.map(a => ({
    date: a.date,
    people: a.people,
    score: a.people.reduce((sum, p) => sum + p.score, 0),
  }))
  const out = calculateStarBest(candidates, duration, timeMap)
  console.log(
    'Completed STAR best fit calculation in ' + (performance.now() - t0) + ' ms'
  )
  return out
}

export type TimeMap = {
  [key: string]: Temporal.ZonedDateTime,
}

// Converting the time strings to Temporal.ZondedDateTime objects is costly, so
// we mitigate this by calculating it only once for each time and putting
// that in a map. E.g. for 224 times (7 days, 9:00-17:00), this takes ~16ms
export const calculateTimeMap = (times: string[], eventTimezone?: string): TimeMap => {
  // For temporal ordering, we need correct instants. For new weekly format,
  // use the event timezone; for legacy format, UTC is fine.
  const timeObjects = convertTimesToDates(times, eventTimezone ?? 'UTC', eventTimezone)
  const map: TimeMap = {}
  for (let i = 0; i < times.length; i++) {
    map[times[i]] = timeObjects[i]
  }
  return map
}

// Change each person's score for a time to be the average score they would give
// to a meeting time of the desired duration if it started at that time
const replaceScoresWithFullScores = (
  times: string[],
  people: PersonResponse[],
  duration: number,
  timeMap: TimeMap,
): (PersonResponse[]) => {
  // number of timeslots the meeting spans
  const numTimeslots = duration / TIMESLOT_MINUTES
  return people.map(p => {
    // expand to all possible times, even if unscored, so times are still
    // considered when the event duration extends over a scored time range
    const fullAvailability = times.map((time: string) => {
      const avail = p.availability.find(a => a.time === time)
      const score = avail ? avail.score : 0
      return ({
        time,
        timeObj: timeMap[time],
        score,
      })
    }).sort((a, b) => Temporal.ZonedDateTime.compare(a.timeObj, b.timeObj)) // sort asc
    const newAvailability = fullAvailability.map((a, idx) => {
      // filter TimeScores that cover the desired meeting duration starting at t
      // (start < other < start+duration), then sum up the scores
      const range = [a.timeObj, a.timeObj.add({ minutes: duration })]
      // Performance is critical here to avoid n^2 complexity. Because the
      // availabilities have been sorted, we can slice only up to numTimeslots
      // in the future and only consider those as potential overlaps
      const score = a.score + fullAvailability
        .slice(idx, idx + numTimeslots) // only consider up to numTimeslots after
        .filter(a2 => timeInsideRange(a2.timeObj, range))
        .reduce((sum: number, cur) => sum + cur.score, 0)
      // (to avoid troubles with floating point arithmetic, we only sum scores
      // without averaging when tabulating)
      return { time: a.time, score }
    })
    return {
      name: p.name,
      availability: dropZeroScores(newAvailability),
      created_at: p.created_at,
    }
  })
}

// Determine if a time is within a range. Returns true if `other` is within the
// time range bounded by range[0] and range[1], but not if it is equal to a bound
//
// Not considering a time to be inside the range if it is equal to a bound lets
// us ignore the timeslot that starts exactly where the meeting ends.
const timeInsideRange = (
  other: Temporal.ZonedDateTime,
  range: Temporal.ZonedDateTime[],
): boolean => {
  // https://tc39.es/proposal-temporal/docs/zoneddatetime.html#compare
  return (Temporal.ZonedDateTime.compare(range[0], other) < 0)
    && (Temporal.ZonedDateTime.compare(other, range[1]) < 0)
}

interface Candidate {
  date: string
  people: NameScore[] // names and (summed) scores given to the candidate
  score: number // the total score given to this time
  rankedWins?: number // number of head-to-head wins among the finalists
}

// Calculate the number of people who prefer `a` over `b`
const calculateRankedWinsBetweenPair = (a: NameScore[], b: NameScore[]): number => {
  let aWins = 0
  for (let k = 0; k < a.length; k++) { // iterate through people
    const aNameScore = a[k]
    const bNameScore = b.find(p => p.name === aNameScore.name)
    if (bNameScore === undefined || aNameScore.score > bNameScore.score) {
      // didn't score `b` at all or scored `a` higher, count as a win for `a`
      // (note: zero scores are not persisted in the data structure)
      aWins++
    }
  }
  return aWins
}

// Calculate the number of people preferring each finalist over each other
// finalist. matchups[i][j] is the number of people who scored finalist i
// strictly higher than finalist j (treating an absent score as zero).
const calculateMatchups = (finalists: Candidate[]): number[][] => {
  const n = finalists.length
  const matchups: number[][] = Array.from({ length: n }, () => Array<number>(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      matchups[i][j] = calculateRankedWinsBetweenPair(finalists[i].people, finalists[j].people)
      matchups[j][i] = calculateRankedWinsBetweenPair(finalists[j].people, finalists[i].people)
    }
  }
  return matchups
}

// Calculate the STAR Voting best pick with explicit ties (see the
// "Explicit Ties" section of the docstring)
const calculateStarBest = (
  candidates: Candidate[],
  duration: number,
  timeMap: TimeMap,
): StarResults => {
  const numTimeslots = duration / TIMESLOT_MINUTES
  // divide by numTimeslots when returning results
  // (dividing by the number of people is done before displaying)
  const toTimeScore = (c: Candidate): TimeScore => ({ time: c.date, score: c.score / numTimeslots })
  const byTime = (a: Candidate, b: Candidate): number =>
    Temporal.ZonedDateTime.compare(timeMap[a.date], timeMap[b.date])
  const byScoreThenTime = (a: Candidate, b: Candidate): number =>
    (b.score - a.score) || byTime(a, b)

  // special cases
  if (candidates.length === 0) {
    return { bestTimes: [], finalists: [], numTopScorers: 0 }
  }
  if (candidates.length === 1) {
    const only = toTimeScore(candidates[0])
    return { bestTimes: [only], finalists: [only], numTopScorers: 1, tieBreak: 'none' }
  }

  // scoring round -> every time with the highest score is a finalist. If only
  // one time has the highest score, every time with the second highest score
  // is also a finalist.
  const topScore = Math.max(...candidates.map(c => c.score))
  const topScorers = candidates.filter(c => c.score === topScore).sort(byTime)
  let secondScore: number | undefined = undefined
  let finalists = topScorers
  if (topScorers.length === 1) {
    const rest = candidates.filter(c => c.score !== topScore)
    secondScore = Math.max(...rest.map(c => c.score))
    finalists = topScorers.concat(rest.filter(c => c.score === secondScore).sort(byTime))
  }

  // runoff round -> the best times are the finalists that win or tie every
  // head-to-head matchup against the other finalists
  const matchups = calculateMatchups(finalists)
  const beats = (i: number, j: number): boolean => matchups[i][j] > matchups[j][i]
  const wins = finalists.map((_, i) => finalists.filter((_, j) => beats(i, j)).length)
  const losses = finalists.map((_, i) => finalists.filter((_, j) => beats(j, i)).length)
  finalists.forEach((f, i) => { f.rankedWins = wins[i] })
  let best = finalists.filter((_, i) => losses[i] === 0)
  let tieBreak: TieBreak = 'headToHead'
  if (best.length === 0) {
    // Every finalist loses at least one matchup (a cycle). We do not break
    // this tie; show every finalist and let the group decide.
    tieBreak = 'cycle'
    best = finalists
  }

  const result: StarResults = {
    bestTimes: best.sort(byScoreThenTime).map(toTimeScore),
    finalists: finalists.map(toTimeScore),
    numTopScorers: topScorers.length,
    tieBreak,
  }
  if (finalists.length === 2) {
    result.firstVotes = matchups[0][1]
    result.secondVotes = matchups[1][0]
  }
  console.log(({
    scoringRound: { topScore, secondScore, finalists: structuredClone(finalists) },
    runoffRound: {
      // matchups[i][j] = people preferring finalists[i] over finalists[j]
      matchups,
      wins,
      losses,
      tieBreak,
      best: structuredClone(best),
    },
    result,
  }))
  return result
}
