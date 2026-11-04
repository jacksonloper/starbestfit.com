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
 * # Excluding Overlaps
 *
 * With long meeting times, there is significant overlap between possible times,
 * which are considered at each 15-minute step. We need to ensure that the
 * runoff round is not a choice between two options that are substantially the
 * same. E.g. for a 60-minute meeting, 11:00 and 11:15 are very similar options
 * that share 3/4 of the same scoring. If 11:00 is the highest scoring time,
 * 11:15 is very likely to be the second highest scoring time, making the runoff
 * less meaningful.
 *
 * 11:00 +------+               <-- highest scoring time
 * 11:15 |      | +------+
 * 11:30 | 4.33 | |      |      <-- second highest scoring time significantly
 * 11:45 |      | | 4.17 |          overlaps the highest scoring time
 * 12:00 +------+ |      |
 * 12:15          +------+
 *
 * To fix this similarity in the runoff, we first find the highest scoring
 * candidate that is guaranteed to make it to the runoff. Then we exclude any
 * other candidates that partially overlap with this highest scoring candidate.
 * With this done, we start the official STAR Voting protocol from the
 * beginning. This way the candidates in the runoff are guaranteed to not
 * overlap, and the second choice option is a more interesting alternative.
 *
 *
 * # Explicit Tiebreaking
 *
 * The official STAR protocol resolves every tie down to a single winner,
 * ultimately with a coin toss. For scheduling, a coin toss hides information:
 * if two times are genuinely tied, the group should see both and decide for
 * themselves. So instead of picking exactly two finalists and exactly one
 * winner, we compute a *set* of best times using only head-to-head matchups:
 *
 * 1. Scoring round. Let N be the number of times sharing the highest total
 *    score and M the number sharing the second highest.
 *    - If N >= 2, the finalists are the N top scoring times.
 *    - If N == 1, the finalists are the top scoring time plus the M second
 *      highest scoring times (N + M finalists in total).
 *    This is the set of times that could have made the official runoff.
 *
 * 2. Runoff round. Every pair of finalists is compared head-to-head: a person
 *    prefers the time they gave the higher (averaged) score. The best times
 *    are the finalists that win or tie *every* head-to-head matchup against
 *    the other finalists. All of them are shown as tied for best, highest
 *    total score first.
 *
 * 3. Cycles. It is possible that every finalist loses at least one matchup
 *    (A beats B, B beats C, C beats A). Then no time satisfies rule 2, and we
 *    fall back to the official STAR tiebreakers that do not involve a coin
 *    toss: the finalists with the most head-to-head wins, then among those the
 *    finalists with the most five-star ratings (see below). Whatever is still
 *    tied after that is shown as tied for best.
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
 * - The result never depends on a coin toss.
 *
 * ## 5-Star Tiebreaking Rule
 *
 * In the official tiebreaking rules, some ties are broken by considering the
 * number of 5-star ratings that are awarded to a candidate. Because rating a
 * time 5 stars in _all_ of its component timeslots is a higher bar than a
 * single 5 star rating for a single timeslot, there is the risk that only a
 * small number of voters will sway the tiebreak if this is taken to be the tie
 * breaking method. To avoid this, we define the 5-star rule to count anytime a
 * person's score for a full meeting time is closer to a 5-star rating than a
 * 4-star rating, which means the average score for the full meeting time is
 * above a 4.5. An exact 4.5 is not closer to 5 than to 4, so we we take the
 * metric to be anytime the average score is strictly greater than 4.5.
 *
 * Rating for a single timeslot, the possible scores are:
 * |   |   |   |   |   |    <-- bars are possible scores
 * 0   1   2   3   4   5
 *                   ^--------- assuming a linear gradient of voter support
 *                              (which should happen with minimal strategic
 *                              voting, which STAR is designed to mitigate),
 *                              and assuming voters approximately round their
 *                              preferences into the nearest discrete rating,
 *                              then anything above a 4.5 preference should
 *                              fall into the 5-star category
 *
 * For a 60-minute meeting time made up of 4 timeslots, possible averages are:
 * |...|...|...|...|...|    <-- dots are new average scores that are possible
 * 0   1   2   3   4   5
 *                   ^--------- 4.5 remains as the threshold for the 5-star
 *                              tiebreaking rule, using the assumption of
 *                              preference linearity
 *
 * ## Coin Toss Tiebreaking Rule
 *
 * The displayed result never depends on a coin toss, but one is still needed
 * to pick the single highest scoring candidate that anchors the overlap
 * exclusion above (when several top scorers overlap each other, one of them
 * has to go). Since results are computed anytime the page is loaded, we need a
 * way to deterministically compute coin toss results. We do this by seeding a
 * pseudorandom number generator with the event id, then drawing a pseudorandom
 * number in the range 0-1 for each possible timeslot in a determined order.
 * When tiebreaking, the time with the higher random number is determined to be
 * the winner. This way a new ordering between times is picked for every event.
 *
 *
 * # Tabulation Implementation
 *
 * The overlap exclusion step uses the official STAR tiebreaking chain to pick
 * one top scorer. It is implemented as a "full round" made of "mini rounds".
 * A full round has a fixed number of winners, and uses tiebreaking protocols
 * to resolve ties. It is implemented as a series of mini rounds. Each mini
 * round attempts to find winners according to a single metric. If there are
 * tied candidates in the round, they are passed to the next mini round for
 * tiebreaking. The possible mini round types are:
 *
 * - "score": winners are the candidates that received the highest scores
 * - "rankedRobin": all pairs of candidates are compared in 1-1 matchups, with
 *   the winners being the candidates that won the most matchups
 * - "fiveStars": winners are the candidates that received the most votes above
 *   a 4.5 score
 * - "random": a random ordering is assigned to each candidate, resolving any
 *   remaining ties
 *
 * The mini rounds used to pick the overlap anchor are: score, rankedRobin,
 * fiveStars, then random. One winner is picked.
 *
 * The best time itself is then computed as described under "Explicit
 * Tiebreaking" in `calculateStarBest`.
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
 * matrix, each finalist's wins and losses, which tiebreak rule applied, and
 * the best candidates), and the final results to display.
 *
 * Candidate objects include the time ("date") of the candidate in UTC, the
 * scores each person gave to a full event of the desired duration if it starts
 * at that time, and the metrics used in tabulation (the total score given to
 * the time, number of head-to-head wins among the finalists, the number of
 * five-stars, and the random tie value)
 */

import { Temporal } from '@js-temporal/polyfill'
import seedrandom from 'seedrandom'

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
  // no finalist won or tied every matchup (a cycle), so bestTimes are the
  // finalists with the most head-to-head wins, then the most five-star ratings
  | 'mostWins'

export interface StarResults {
  // All times tied for best (see "Explicit Tiebreaking" above), highest
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
  // How bestTimes were separated from the other finalists (undefined when
  // there are no candidates)
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
  eventId: string,
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
  let candidates =
    calculateSimpleCandidateMetrics(dateCollated.availabilities, duration, eventId)
  candidates = removeOverlapsWithTopScorer(candidates, duration, timeMap)
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
// us ignore cases where candidate times share a bound, but do not otherwise
// overlap, and the case where a time's start or end is compared against itself,
// as with the filter() call in removeOverlapsWithTopScorer.
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
  people: NameScore[] // names and average scores given to the candidate
  score: number // the total score given to this time
  rankedWins?: number // number of 1-1 ranked wins for this time over other times
  fiveStars: number // number of "five stars" given to the time (see docstring)
  randomTieValue: number // random value in range 0-1 for tie breaking
}

// Calculate the simpler metrics that are used in tie breaking which do not
// depend on the remaining candidates. Ranked robin is the exception here.
const calculateSimpleCandidateMetrics = (
  times: Availability[], 
  duration: number,
  eventId: string
): Candidate[] => {
  const numTimeslots = duration / TIMESLOT_MINUTES
  const scores = []
  const fiveStars = []
  const randomTieValues = []
  // const myrng = new Math.seedrandom(eventId)
  const myrng = seedrandom(eventId)
  for (let i = 0; i < times.length; i++) {
    scores.push(times[i].people.reduce((sum, p) => sum += p.score, 0))
    fiveStars.push( // count time as five stars if the average score is >4.5
      times[i].people.filter(
        (p: NameScore) => (p.score / numTimeslots) > (MAXSCORE - 0.5)
      ).length
    )
    randomTieValues.push(myrng())
  }
  const candidates = []
  for (let i = 0; i < times.length; i++) {
    candidates.push(({
      date: times[i].date,
      people: times[i].people,
      score: scores[i],
      rankedWins: undefined, // computed for each ranked robin round
      fiveStars: fiveStars[i],
      randomTieValue: randomTieValues[i],
    }))
  }
  return candidates
}

// Calulcate ranked robin wins among the remaining candidates. Since this scoring
// depends on the number of candidates remaining, it is done before each ranked
// robin round. Candidates' rankedWins values are edited in-place.
const calculateRankedWins = (candidates: Candidate[]): void => {
  const rankedWins = Array<number>(candidates.length).fill(0)
  for (let i = 0; i < candidates.length; i++) {
    // consider all pairs of people for ranked robin
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i].people
      const b = candidates[j].people
      rankedWins[i] += calculateRankedWinsBetweenPair(a, b)
      rankedWins[j] += calculateRankedWinsBetweenPair(b, a)
    }
    candidates[i].rankedWins = rankedWins[i]
  }
}

// Calculate the number of rank wins of `a` over `b`
const calculateRankedWinsBetweenPair = (a: NameScore[], b: NameScore[]): number => {
  let aWins = 0
  for (let k = 0; k < a.length; k++) { // iterate through people
    const aNameScore = a[k]
    const bNameScore = b.find(p => p.name === aNameScore.name)
    if (bNameScore === undefined || aNameScore.score > bNameScore.score) {
      // didn't rank `b` at all or `a` was ranked higher, count as a win for `a`
      // (note: zero scores are not presisted in the data structure)
      aWins++
    }
  }
  return aWins
}

// Remove any candidates that overlap with the highest scoring candidate. This
// ensures that the options in the runoff are interesting and don't significantly
// overlap each other.
const removeOverlapsWithTopScorer = (
  candidates: Candidate[],
  duration: number,
  timeMap: TimeMap,
): Candidate[] => {
  if (candidates.length > 2) {
    const scoreResult = 
      calculateFullRound(1, candidates, ["score", "rankedRobin", "fiveStars", "random"])
    const highestScored = scoreResult.winners[0] as Candidate
    const start = timeMap[highestScored.date]
    const end = start.add({ minutes: duration })
    // we don't have to add back the highestScored because the start and end
    // bounds are identical to the range we'd test against, and equality at the
    // bounds is not counted as "inside"
    candidates = candidates.filter(other => {
      const otherStart = timeMap[other.date]
      const otherEnd = otherStart.add({ minutes: duration })
      return !(timeInsideRange(otherStart, [start, end])
              || timeInsideRange(otherEnd, [start, end]))
    })
  }
  return candidates
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

// Calculate the STAR Voting best pick with explicit tiebreaking (see the
// "Explicit Tiebreaking" section of the docstring)
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
    // Every finalist loses at least one matchup (a cycle). Fall back to the
    // official STAR tiebreakers that do not involve a coin toss, and show
    // every time that is still tied after them.
    tieBreak = 'mostWins'
    const maxWins = Math.max(...wins)
    best = finalists.filter((_, i) => wins[i] === maxWins)
    const maxFiveStars = Math.max(...best.map(c => c.fiveStars))
    best = best.filter(c => c.fiveStars === maxFiveStars)
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

/* Results from a full round calculcation */
interface FullRoundResult {
  candidates: Candidate[],
  rounds: MiniRoundResult[],
  winners: Candidate[],
}

// Calculate a full round using a sequence of scoring functions / mini rounds.
// Returns when the desired number of winning candidates has been found.
const calculateFullRound = (
  numWinners: number, // desired number of winners
  candidates: Candidate[],
  miniRounds: miniRoundType[],
): FullRoundResult => {
  const startingCandidates = structuredClone(candidates) // clone to keep metrics
  let rounds: MiniRoundResult[] = []
  let winners: Candidate[] = []
  for (let i = 0; i < miniRounds.length; i++) {
    // `numWinners - winners.length` lets us break ties for second place, if needed
    const roundResult =
      calculateMiniRound(numWinners - winners.length, candidates, miniRounds[i])
    rounds = rounds.concat(roundResult)
    // save candidates that won in that miniround and remove from further tiebreaking
    winners = winners.concat(roundResult.winners)
    // remaining candidates tied for a winning spot in the mini round
    candidates = roundResult.tied
    if (winners.length === numWinners) {
      break
    }
  }
  return ({
    candidates: startingCandidates,
    rounds,
    winners
  })
}

interface MiniRoundResult {
  /* The type of mini round */
  roundType: miniRoundType,
  /* Candidates with relevant metrics */
  candidates: Candidate[],
  /* The winners of the mini round */
  winners: Candidate[],
  /* Candidates that are still tied after this miniround */
  tied: Candidate[],
}

type miniRoundType = "score" | "rankedRobin" | "fiveStars" | "random"

// Compute the winning candidates and those that are still tied given a round
// type. This is a "mini round" because only a single method is used to
// distinguish between candidates and ties are not necessarily resolved.
const calculateMiniRound = (
  numWinners: number,
  candidates: Candidate[],
  roundType: miniRoundType
): MiniRoundResult => {
  if (numWinners >= candidates.length) {
    throw new Error("calculateMiniRound should be called with more candidates \
                    than the desired number of winners")
  }
  if (roundType === "rankedRobin") {
    // calculate ranked wins with the candidates still under consideration
    calculateRankedWins(candidates)
  }
  const scoringFunc = (time: Candidate): number => getMetric(time, roundType)
  candidates =
    candidates.sort((a, b) => scoringFunc(b) - scoringFunc(a)) // sort descending
  const scoreToBeat = scoringFunc(candidates[numWinners])
  const winners = candidates.filter(w => scoringFunc(w) > scoreToBeat)
  let tied: Candidate[]
  if (winners.length === numWinners) {
    tied = []
  } else {
    // didn't find enough winners, keep the candidates that were tied
    tied = candidates.filter(w => scoringFunc(w) === scoreToBeat)
  }
  return ({
    roundType,
    candidates: structuredClone(candidates), // clone to keep the current metrics
    winners: structuredClone(winners),
    tied: structuredClone(tied)
  })
}

// Retrieve a scoring metric for a candidate based on the mini round type
const getMetric = (
  candidate: Candidate,
  metric: miniRoundType
): number => {
  if (metric === "score") {
    return candidate.score
  } else if (metric === "rankedRobin") {
    if (candidate.rankedWins === undefined) {
      throw new Error("ranked wins were not calculated before ranked robin round")
    }
    return candidate.rankedWins
  } else if (metric === "fiveStars") {
    return candidate.fiveStars
  } else {
    return candidate.randomTieValue
  }
}
